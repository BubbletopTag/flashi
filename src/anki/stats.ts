// SPDX-License-Identifier: AGPL-3.0-or-later
// Statistics derived from the schema-11 collection/review log. Study-day
// grouping uses the collection's local rollover and handles DST via Date.
import type { Collection } from './collection';
import { cardScope } from './scope';
import { num } from './sqlite';
import { parseCardData } from './model';

export interface StudyDay { date: string; count: number; milliseconds: number; learning: number; review: number; relearn: number }
export interface Statistics {
  cards: { new: number; learning: number; relearning: number; young: number; mature: number; suspended: number; buried: number; total: number; notes: number };
  today: { answers: number; cards: number; milliseconds: number; again: number; learning: number; review: number; relearning: number; filtered: number; mature: number; matureCorrect: number };
  period: { answers: number; daysStudied: number; milliseconds: number; reviewSuccess: number; reviewTotal: number };
  calendar: StudyDay[];
  history: StudyDay[];
  forecast: number[];
  answers: number[];
  intervals: number[];
  hours: number[];
  hourlyCorrect: number[];
  answerGroups: number[][];
  added: number[];
  ease: number[];
  retention: { young: number[]; mature: number[] };
  memory: { count: number; stability: number[]; difficulty: number[]; retrievability: number[]; averageRetrievability: number };
  currentStreak: number;
  longestStreak: number;
}
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function studyDate(ms: number, rollover: number): string {
  const date = new Date(ms);
  if (date.getHours() < rollover) date.setDate(date.getDate() - 1);
  return dayKey(date);
}
export function statistics(col: Collection, deckId: number | null = null, days = 31, nowMs = Date.now()): Statistics {
  const now = Math.floor(nowMs / 1000);
  const timing = col.timing(now);
  const rollover = Number(col.conf.rollover ?? 4);
  const todayKey = studyDate(nowMs, rollover);
  const scope = cardScope(col, deckId);
  const cards: Statistics['cards'] = { new: 0, learning: 0, relearning: 0, young: 0, mature: 0, suspended: 0, buried: 0, total: 0, notes: 0 };
  const forecast = Array<number>(31).fill(0);
  const intervals = Array<number>(8).fill(0);
  const ease = Array<number>(9).fill(0);
  const added = Array<number>(365).fill(0);
  const memory = { count:0,stability:Array<number>(8).fill(0),difficulty:Array<number>(10).fill(0),retrievability:Array<number>(10).fill(0),averageRetrievability:0 };
  const end = new Date(timing.nextDayAt * 1000);
  const calendarStart = new Date(end); calendarStart.setDate(calendarStart.getDate() - 365);
  const calendarKeys = new Map<string, number>();
  for (let i = 0; i < 365; i++) { const date = new Date(calendarStart); date.setDate(date.getDate() + i); calendarKeys.set(dayKey(date), i); }
  const noteIds = new Set<number>();
  col.db.each(`select c.nid,c.type,c.queue,c.due,c.ivl,c.factor,c.id,c.data from cards c where ${scope.sql}`, scope.bind, (row) => {
    const [nid, type, queue, due, interval, factor, id] = row.slice(0,7).map((value) => num(value));
    const data=parseCardData(String(row[7]??''));
    if(data.s&&data.s>0&&data.d&&data.d>=1){
      memory.count++;
      const bin=[1,7,21,30,90,180,365].findIndex(limit=>data.s!<=limit);memory.stability[bin<0?7:bin]=memory.stability[bin<0?7:bin]!+1;
      const difficulty=Math.min(9,Math.max(0,Math.floor((data.d-1)/9*10)));memory.difficulty[difficulty]=memory.difficulty[difficulty]!+1;
      const last=data.lrt??num(col.db.scalar('select max(id)/1000 from revlog where cid=? and ease between 1 and 4 and type between 0 and 3',[id!]));
      if(last){const elapsed=Math.max(0,Math.floor((timing.nextDayAt-last)/86400)),decay=-(data.decay??.5);const factor=Math.pow(.9,1/decay)-1;const probability=Math.pow(1+factor*elapsed/data.s,decay);const bucket=Math.min(9,Math.max(0,Math.floor(probability*10)));memory.retrievability[bucket]=memory.retrievability[bucket]!+1;memory.averageRetrievability+=probability;}
    }
    cards.total++; noteIds.add(nid!);
    const addedIndex = calendarKeys.get(studyDate(id!, rollover));
    if (addedIndex !== undefined) added[addedIndex] = added[addedIndex]! + 1;
    if (queue === -1) cards.suspended++;
    else if (queue! < -1) cards.buried++;
    else if (type === 0) cards.new++;
    else if (type === 1) cards.learning++;
    else if (type === 3) cards.relearning++;
    else if (interval! >= 21) cards.mature++;
    else cards.young++;
    if (queue === 2 || queue === 3 || queue === 1) {
      const day = queue === 1 ? (due! < timing.nextDayAt ? 0 : 1 + Math.floor((due! - timing.nextDayAt) / 86400)) : Math.max(0, due! - timing.daysElapsed);
      if (day < forecast.length) forecast[day] = forecast[day]! + 1;
    }
    if (type === 2 || type === 3) {
      if (factor! > 0) { const bin = Math.max(0, Math.min(8, Math.floor((factor! - 1300) / 250))); ease[bin] = ease[bin]! + 1; }
      const bin = [1, 7, 21, 30, 90, 180, 365].findIndex((limit) => interval! <= limit);
      intervals[bin < 0 ? 7 : bin] = intervals[bin < 0 ? 7 : bin]! + 1;
    }
  });
  cards.notes = noteIds.size;
  const start = new Date(end); start.setDate(start.getDate() - (days || 365));
  const periodStart = days ? start.getTime() : 0;
  const buckets = new Map<string, StudyDay>();
  const answers = [0, 0, 0, 0];
  const hours = Array<number>(24).fill(0);
  const hourlyCorrect = Array<number>(24).fill(0);
  const answerGroups = Array.from({length: 3}, () => [0, 0, 0, 0]);
  const retention = { young: [0, 0], mature: [0, 0] };
  const today: Statistics['today'] = { answers: 0, cards: 0, milliseconds: 0, again: 0, learning: 0, review: 0, relearning: 0, filtered: 0, mature: 0, matureCorrect: 0 };
  let milliseconds = 0; let total = 0; let reviewSuccess = 0; let reviewTotal = 0;
  let todayMs = 0; let todayAnswers = 0;
  const todayCards = new Set<number>();
  // Unscoped history includes deleted cards, like Anki's collection statistics.
  const join = deckId === null ? '' : 'join cards c on c.id=r.cid';
  const where = deckId === null ? '1' : scope.sql;
  col.db.each(`select r.id,r.cid,r.ease,r.time,r.type,r.lastIvl from revlog r ${join} where ${where} and r.ease between 1 and 4 and r.type between 0 and 3 and r.id>=? and r.id<=? order by r.id`, [...(deckId === null ? [] : scope.bind), Math.min(periodStart, calendarStart.getTime()), nowMs], (row) => {
    const id = num(row[0]); const cid = num(row[1]); const ease = num(row[2]); const time = num(row[3]); const type = num(row[4]);
    const key = studyDate(id, rollover);
    const mature = num(row[5]) >= 21;
    let day = buckets.get(key);
    if (!day) { day = { date: key, count: 0, milliseconds: 0, learning: 0, review: 0, relearn: 0 }; buckets.set(key, day); }
    day.count++; day.milliseconds += time;
    if (type === 0) day.learning++; else if (type === 2) day.relearn++; else day.review++;
    if (key === todayKey) {
      todayAnswers++; todayMs += time; todayCards.add(cid);
      if (ease === 1) today.again++;
      if (type === 0) today.learning++; else if (type === 1) today.review++; else if (type === 2) today.relearning++; else today.filtered++;
      if (type === 1 && mature) { today.mature++; if (ease > 1) today.matureCorrect++; }
    }
    if (id >= periodStart) {
      total++; milliseconds += time; answers[ease - 1] = answers[ease - 1]! + 1;
      const hour = new Date(id).getHours(); hours[hour] = hours[hour]! + 1;
      if (ease > 1) hourlyCorrect[hour] = hourlyCorrect[hour]! + 1;
      const group = type === 0 || type === 2 ? 0 : mature ? 2 : 1;
      answerGroups[group]![ease - 1] = answerGroups[group]![ease - 1]! + 1;
      if (type === 1 || num(row[5]) >= 1 || num(row[5]) <= -86400) { const bucket = mature ? retention.mature : retention.young; bucket[ease > 1 ? 0 : 1] = bucket[ease > 1 ? 0 : 1]! + 1; }
      if (type === 1 || type === 3) { reviewTotal++; if (ease > 1) reviewSuccess++; }
    }
  });
  const calendar: StudyDay[] = [];
  for (let i = 0; i < 365; i++) {
    const date = new Date(calendarStart); date.setDate(date.getDate() + i);
    const key = dayKey(date);
    calendar.push(buckets.get(key) ?? { date: key, count: 0, milliseconds: 0, learning: 0, review: 0, relearn: 0 });
  }
  let longestStreak = 0; let streak = 0;
  for (const day of calendar) { streak = day.count ? streak + 1 : 0; longestStreak = Math.max(longestStreak, streak); }
  let currentStreak = 0;
  for (let i = calendar.length - (calendar.at(-1)?.count ? 1 : 2); i >= 0 && calendar[i]!.count > 0; i--) currentStreak++;
  const history = [...buckets.values()].filter((day) => !days || day.date >= dayKey(start)).sort((a, b) => a.date.localeCompare(b.date));
  Object.assign(today, { answers: todayAnswers, cards: todayCards.size, milliseconds: todayMs });
  memory.averageRetrievability/=Math.max(1,memory.retrievability.reduce((a,b)=>a+b,0));
  return { cards, today, period: { answers: total, daysStudied: history.filter((day) => day.count > 0).length, milliseconds, reviewSuccess, reviewTotal }, calendar, history, forecast, answers, intervals, hours, hourlyCorrect, answerGroups, added, ease, retention, memory, currentStreak, longestStreak };
}
