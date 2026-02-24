import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stations = JSON.parse(readFileSync(join(__dirname, '../../public/schedule-data/stations.json'), 'utf-8'));

// stations.json is ordered Lindenwold → 15-16th-locust (westbound direction)
const WESTBOUND_STATIONS = stations.map(s => s.name);
const EASTBOUND_STATIONS = [...WESTBOUND_STATIONS].reverse();

const TIME_REGEX_SOURCE = '(?:1[0-2]|0?[1-9]):(?:[0-5][0-9])\\s*(?:A|P|M)?|\\s*\\u00e0';

/**
 * Extract text from PDF at URL.
 * @param {string} pdfUrl - URL to fetch the PDF from
 * @returns {Promise<string>} Concatenated text from all pages
 */
export async function extractTextFromUrl(pdfUrl) {
  const res = await fetch(pdfUrl);
  if (!res.ok) throw new Error(`PDF fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();

  const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
  let fullText = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map(item => item.str).join('');
  }
  return fullText;
}

/**
 * Convert "H:MM A/P" or "H:MM AM/PM" to 24-hour "HH:MM".
 */
function parsePdfTime(raw) {
  const m = raw.match(/^(\d{1,2}):(\d{2})\s*(A|P)M?$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2];
  const isPM = m[3].toUpperCase() === 'P';
  if (isPM && hour !== 12) hour += 12;
  if (!isPM && hour === 12) hour = 0;
  return String(hour).padStart(2, '0') + ':' + minute;
}

/**
 * Distribute time matches to stations in round-robin order, converting to 24h format.
 */
function distributeTimesToStations(matches, stationList) {
  const stationTimes = {};
  stationList.forEach(s => stationTimes[s] = []);
  for (let i = 0; i < matches.length; i++) {
    const station = stationList[i % stationList.length];
    let raw = matches[i].trim();
    if (raw.includes('\u00e0')) {
      continue; // skip-stop: train doesn't stop here
    }
    // Normalize "4:30A" / "4:30 A" → "4:30 AM" for parsePdfTime
    raw = raw
      .replace(/\s*(A)M?\s*$/i, ' AM')
      .replace(/\s*(P)M?\s*$/i, ' PM');
    const time = parsePdfTime(raw);
    if (time) {
      stationTimes[station].push(time);
    }
  }
  return stationTimes;
}

function cleanNoiseText(text) {
  return text
    .replace(/STATIONS CLOSED[^.]*\.\s*SERVICE RESUMES[^.]*/g, '')
    .replace(/à Indicates[^.]*/g, '');
}

function timeToMinutes(raw) {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})\s*(A|P)M?$/i);
  if (!m) return -1;
  let hr = parseInt(m[1]);
  const min = parseInt(m[2]);
  if (m[3].toUpperCase() === 'P' && hr !== 12) hr += 12;
  if (m[3].toUpperCase() === 'A' && hr === 12) hr = 0;
  return hr * 60 + min;
}

function findDirectionBoundary(matches, stationsPerRow) {
  for (let i = stationsPerRow; i < matches.length; i += stationsPerRow) {
    const prev = timeToMinutes(matches[i - stationsPerRow]);
    const curr = timeToMinutes(matches[i]);
    if (prev !== -1 && curr !== -1 && prev - curr > 360) {
      return i;
    }
  }
  return -1;
}

/**
 * Parse extracted PDF text into eastbound/westbound station times.
 * @param {string} text - Raw text extracted from PDF
 * @returns {object|null} { eastbound: {...}, westbound: {...} } with 24h times, or null
 */
export function parseSpecialSchedulePdfText(text) {
  const clean = cleanNoiseText(text);

  const parts = clean.split('WESTBOUND TO PHILADELPHIA, PA');
  const beforeDelimiter = parts[0] || '';
  const afterDelimiter = parts[1] || '';

  let wbMatches, ebMatches;
  const timeRegex = () => new RegExp(TIME_REGEX_SOURCE, 'gi');

  const beforeMatches = beforeDelimiter.match(timeRegex()) || [];
  const afterMatches = afterDelimiter.match(timeRegex()) || [];

  if (beforeMatches.length > 0 && afterMatches.length > 0) {
    // Type A: standard layout — times on both sides of delimiter
    console.log(`PDF standard format — WB: ${beforeMatches.length}, EB: ${afterMatches.length}`);
    wbMatches = beforeMatches;
    ebMatches = afterMatches;
  } else {
    // Type B: all times in one block — use boundary detection
    const allMatches = clean.match(timeRegex()) || [];
    console.log(`PDF alternate format — total matches: ${allMatches.length}`);
    const boundary = findDirectionBoundary(allMatches, WESTBOUND_STATIONS.length);
    if (boundary > 0) {
      wbMatches = allMatches.slice(0, boundary);
      ebMatches = allMatches.slice(boundary);
      console.log(`Direction boundary at index ${boundary} — WB: ${wbMatches.length}, EB: ${ebMatches.length}`);
    } else {
      console.log('Could not find direction boundary in time data');
      return null;
    }
  }

  return {
    eastbound: distributeTimesToStations(ebMatches, EASTBOUND_STATIONS),
    westbound: distributeTimesToStations(wbMatches, WESTBOUND_STATIONS),
  };
}

/**
 * Download PDF from URL and parse it into a special schedule object.
 * @param {string} pdfUrl
 * @returns {Promise<object|null>}
 */
export async function downloadAndParsePdf(pdfUrl) {
  console.log(`Downloading PDF from ${pdfUrl}`);
  const text = await extractTextFromUrl(pdfUrl);
  console.log(`PDF text length: ${text.length}`);

  const parsed = parseSpecialSchedulePdfText(text);
  if (!parsed) return null;

  // Check if any times were actually extracted
  for (const dir of ['eastbound', 'westbound']) {
    for (const station in parsed[dir]) {
      if (parsed[dir][station].length > 0) return parsed;
    }
  }

  console.log('Special schedule parsed but contained no departure times');
  return null;
}

/**
 * Extract YYYY-MM-DD date from a PDF URL.
 */
export function extractDateFromPdfUrl(pdfUrl) {
  const match = pdfUrl.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}
