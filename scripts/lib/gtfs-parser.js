// GTFS CSV → schedule JSON

import { readFileSync } from 'fs';
import { join } from 'path';

const STOP_ID_TO_KEY = {
  '1': 'lindenwold',
  '2': 'ashland',
  '3': 'woodcrest',
  '4': 'haddonfield',
  '5': 'westmont',
  '6': 'collingswood',
  '7': 'ferry-ave',
  '8': 'broadway',
  '9': 'city-hall',
  '10': 'franklin-square',
  '11': '8th-market',
  '12': '9-10th-locust',
  '13': '12-13th-locust',
  '14': '15-16th-locust',
};

const DIRECTIONS = { '0': 'westbound', '1': 'eastbound' };
const STATIONS = Object.values(STOP_ID_TO_KEY);

function serviceToDayType(serviceId) {
  const lower = serviceId.toLowerCase();
  if (lower.includes('weekday')) return 'weekday';
  if (lower.includes('saturday')) return 'saturday';
  if (lower.includes('sunday')) return 'sunday';
  return null;
}

function parseCSV(csvString) {
  const lines = csvString.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const values = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = (values[i] || '').trim(); });
    return row;
  });
}

function truncateToHHMM(timeStr) {
  return timeStr.substring(0, 5);
}

function createEmptySchedule() {
  const sched = {};
  for (const dir of Object.values(DIRECTIONS)) {
    sched[dir] = {};
    for (const station of STATIONS) {
      sched[dir][station] = [];
    }
  }
  return sched;
}

/**
 * Build schedule JSON from a directory containing GTFS CSV files.
 * @param {string} gtfsDir - Path to directory with calendar.txt, trips.txt, stop_times.txt
 * @returns {object} Schedule object keyed by day type
 */
export function buildScheduleFromDir(gtfsDir) {
  const calendarCsv = readFileSync(join(gtfsDir, 'calendar.txt'), 'utf-8');
  const tripsCsv = readFileSync(join(gtfsDir, 'trips.txt'), 'utf-8');
  const stopTimesCsv = readFileSync(join(gtfsDir, 'stop_times.txt'), 'utf-8');

  return buildScheduleFromCSVs(calendarCsv, tripsCsv, stopTimesCsv);
}

/**
 * Build schedule JSON from CSV strings.
 * @returns {object} Schedule object keyed by day type
 */
export function buildScheduleFromCSVs(calendarCsv, tripsCsv, stopTimesCsv) {
  const calendar = parseCSV(calendarCsv);
  const trips = parseCSV(tripsCsv);
  const stopTimes = parseCSV(stopTimesCsv);

  const tripMap = new Map();
  for (const trip of trips) {
    tripMap.set(trip.trip_id, {
      serviceId: trip.service_id,
      directionId: trip.direction_id,
    });
  }

  const serviceDayTypes = new Map();
  for (const row of calendar) {
    const dayType = serviceToDayType(row.service_id);
    if (dayType) {
      serviceDayTypes.set(row.service_id, dayType);
    }
  }

  const specialServices = new Map();
  for (const row of calendar) {
    if (!serviceDayTypes.has(row.service_id)) {
      const key = row.service_id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
      specialServices.set(row.service_id, key);
    }
  }

  const schedule = {};
  for (const dayType of new Set(serviceDayTypes.values())) {
    schedule[dayType] = createEmptySchedule();
  }
  for (const [, key] of specialServices) {
    schedule[key] = createEmptySchedule();
  }

  let processed = 0;
  for (const row of stopTimes) {
    const trip = tripMap.get(row.trip_id);
    if (!trip) continue;

    const stationKey = STOP_ID_TO_KEY[row.stop_id];
    if (!stationKey) continue;

    const direction = DIRECTIONS[trip.directionId];
    if (!direction) continue;

    let dayType = serviceDayTypes.get(trip.serviceId);
    if (!dayType) dayType = specialServices.get(trip.serviceId);
    if (!dayType) continue;

    schedule[dayType][direction][stationKey].push(truncateToHHMM(row.departure_time));
    processed++;
  }

  for (const dayType of Object.keys(schedule)) {
    for (const direction of Object.keys(schedule[dayType])) {
      for (const station of Object.keys(schedule[dayType][direction])) {
        schedule[dayType][direction][station].sort();
      }
    }
  }

  console.log(`Processed ${processed} stop times`);
  console.log(`Day types: ${Object.keys(schedule).join(', ')}`);
  return schedule;
}
