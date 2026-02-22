const DEVELOPERS_URL = 'https://www.ridepatco.org/developers/';
const SCHEDULES_URL = 'https://www.ridepatco.org/schedules/schedules.asp';

/**
 * Fetch the GTFS effective date
 * @returns {Promise<string>} Date string in YYYY-MM-DD format
 */
export async function fetchGtfsEffectiveDate() {
  const res = await fetch(DEVELOPERS_URL);
  const html = await res.text();

  const match = html.match(/timetable effective (\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (!match) {
    throw new Error('Could not find effective date on developers page');
  }

  const month = match[1].padStart(2, '0');
  const day = match[2].padStart(2, '0');
  const year = match[3];
  return `${year}-${month}-${day}`;
}

/**
 * Fetch the schedules page for special schedule PDF links.
 * @returns {Promise<Array<{date: string, pdfUrl: string}>>}
 */
export async function fetchSpecialSchedules() {
  const res = await fetch(SCHEDULES_URL);
  const html = await res.text();

  // Find "Special Schedule(s)" section — flexible regex handles malformed HTML nesting
  const specialSchedRegex = /Special Schedule\(s\)([\s\S]*?)(?:<\/td>|<hr)/i;
  const specialSchedMatch = html.match(specialSchedRegex);

  if (!specialSchedMatch) {
    console.log('No special schedules section found on page');
    return [];
  }

  const specialSchedulesHtml = specialSchedMatch[1];
  return parseSpecialScheduleLinks(specialSchedulesHtml);
}

/**
 * Parse <LI><A> links from the special schedules HTML section.
 */
function parseSpecialScheduleLinks(html) {
  const result = [];

  const liRegex = /<li[^>]*>\s*<a[^>]*href\s*=\s*['"]([^'"]*)['"]\s*[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = liRegex.exec(html)) !== null) {
    let pdfUrl = match[1].trim();
    const date = match[2].replace(/(<([^>]+)>)/gi, '').trim();

    if (!pdfUrl.toLowerCase().endsWith('.pdf')) continue;

    if (!pdfUrl.startsWith('http')) {
      pdfUrl = `https://www.ridepatco.org/schedules/${pdfUrl.replace(/^\.+\//, '')}`;
    }

    result.push({ date, pdfUrl });
  }

  return result;
}
