#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { buildScheduleFromDir } from './lib/gtfs-parser.js';
import { fetchGtfsEffectiveDate, fetchSpecialSchedules } from './lib/schedule-checker.js';
import { downloadAndParsePdf, extractDateFromPdfUrl } from './lib/pdf-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'site', 'data');
const TEMP_DIR = join(__dirname, '..', 'temp');
const METADATA_PATH = join(DATA_DIR, 'metadata.json');
const GTFS_SCHEDULE_PATH = join(DATA_DIR, 'gtfs_schedule.json');
const SPECIAL_SCHEDULES_PATH = join(DATA_DIR, 'special_schedules.json');

const GTFS_ZIP_URL = 'https://rapid.nationalrtap.org/GTFSFileManagement/UserUploadFiles/13562/PATCO_GTFS.zip';

function loadJSON(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJSON(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

async function checkAndUpdateGtfs(metadata) {
  console.log('Checking GTFS effective date...');
  const effectiveDate = await fetchGtfsEffectiveDate();
  console.log(`Effective date: ${effectiveDate}`);

  if (metadata.gtfsEffectiveDate === effectiveDate) {
    console.log('GTFS schedule is up to date');
    return false;
  }

  console.log(`New GTFS schedule: ${metadata.gtfsEffectiveDate || '(none)'} → ${effectiveDate}`);

  console.log('Downloading GTFS ZIP...');
  const res = await fetch(GTFS_ZIP_URL);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`Downloaded ${buf.length} bytes`);

  mkdirSync(TEMP_DIR, { recursive: true });
  const zipPath = join(TEMP_DIR, 'gtfs.zip');
  writeFileSync(zipPath, buf);
  execSync(`unzip -o -j "${zipPath}" -d "${TEMP_DIR}"`, { stdio: 'pipe' });

  const needed = ['calendar.txt', 'trips.txt', 'stop_times.txt'];
  for (const filename of needed) {
    if (!existsSync(join(TEMP_DIR, filename))) {
      throw new Error(`${filename} not found in GTFS ZIP`);
    }
    console.log(`Extracted ${filename}`);
  }

  const schedule = buildScheduleFromDir(TEMP_DIR);
  writeJSON(GTFS_SCHEDULE_PATH, schedule);
  console.log(`Wrote gtfs_schedule.json`);

  metadata.gtfsEffectiveDate = effectiveDate;
  return true;
}

async function checkAndUpdateSpecialSchedules(metadata) {
  console.log('Checking for special schedule PDFs...');
  const entries = await fetchSpecialSchedules();
  console.log(`Found ${entries.length} special schedule(s) on site`);

  if (entries.length === 0) {
    writeJSON(SPECIAL_SCHEDULES_PATH, {});
    return false;
  }

  const existing = loadJSON(SPECIAL_SCHEDULES_PATH) || {};
  let changed = false;
  const today = todayStr();

  for (const entry of entries) {
    const dateStr = extractDateFromPdfUrl(entry.pdfUrl);
    if (!dateStr) {
      console.log(`Could not extract date from: ${entry.pdfUrl}`);
      continue;
    }

    if (existing[dateStr]) {
      console.log(`Already have schedule for ${dateStr}`);
      continue;
    }

    if (dateStr < today) {
      console.log(`Skipping past date: ${dateStr}`);
      continue;
    }

    try {
      console.log(`Parsing special schedule for ${dateStr}...`);
      const parsed = await downloadAndParsePdf(entry.pdfUrl);
      if (parsed) {
        existing[dateStr] = {
          ...parsed,
          pdfUrl: entry.pdfUrl,
          dateLabel: entry.date,
        };
        changed = true;
        console.log(`Added special schedule for ${dateStr}`);
      }
    } catch (err) {
      console.log(`Failed to parse ${entry.pdfUrl}: ${err.message}`);
    }
  }

  for (const key of Object.keys(existing)) {
    if (key < today) {
      delete existing[key];
      changed = true;
    }
  }

  if (changed) {
    writeJSON(SPECIAL_SCHEDULES_PATH, existing);
    console.log('Wrote special_schedules.json');
  }

  return changed;
}

async function main() {
  console.log('PATCO Timetable — Data Pipeline');
  console.log(`Date: ${todayStr()}\n`);

  mkdirSync(DATA_DIR, { recursive: true });

  let metadata = loadJSON(METADATA_PATH) || {};
  let anyChanges = false;

  try {
    const gtfsChanged = await checkAndUpdateGtfs(metadata);
    anyChanges = anyChanges || gtfsChanged;
  } catch (err) {
    console.error(`GTFS check failed: ${err.message}`);
  }

  try {
    const specialChanged = await checkAndUpdateSpecialSchedules(metadata);
    anyChanges = anyChanges || specialChanged;
  } catch (err) {
    console.error(`Special schedule check failed: ${err.message}`);
  }

  metadata.lastCheck = new Date().toISOString();
  writeJSON(METADATA_PATH, metadata);

  if (anyChanges) {
    console.log('\nData updated!');
  } else {
    console.log('\nNo changes detected.');
  }
}

main().catch(err => {
  console.error(`Pipeline failed: ${err.message}`);
  process.exit(1);
});
