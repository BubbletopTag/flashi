// SPDX-License-Identifier: AGPL-3.0-or-later
// Layout and graph order follow Anki's graphs page, also used by AnkiDroid.
import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { AppController } from '../app/controller';
import { Toolbar } from '../app/ui';
import { statistics, type StudyDay } from '../anki/stats';

const BLUE = '#6baed6', GREEN = '#74c476';
export function BarChart({ values, labels, label, color = BLUE, colors, rates }: { values: number[]; labels: string[]; label: string; color?: string; colors?: string[]; rates?: Array<number|null> }) {
  const max = Math.max(1, ...values);
  const magnitude = 10 ** Math.floor(Math.log10(max / 4));
  const tickStep = Math.max(1, Math.ceil(max / 4 / magnitude) * magnitude);
  const axisMax = Math.ceil(max / tickStep) * tickStep;
  const ticks = Array.from({length: Math.round(axisMax / tickStep) + 1}, (_, i) => i * tickStep);
  const step = 460 / Math.max(1, values.length);
  return <div class="chart-wrap"><svg viewBox="0 0 600 250" role="img" aria-label={label}>
    {ticks.map((tick) => <g><line x1="70" x2="530" y1={225 - 205 * tick / axisMax} y2={225 - 205 * tick / axisMax} stroke="var(--divider)" /><text x="62" y={230 - 205 * tick / axisMax} text-anchor="end">{tick}</text></g>)}
    {values.map((value, i) => <rect x={70 + i * step} y={225 - value / axisMax * 205} width={Math.max(.5, step - 1)} height={value / axisMax * 205} fill={colors?.[i] ?? color}><title>{labels[i]}: {Number(value.toFixed(2))}</title></rect>)}
    {rates && <g>{[0,.5,1].map(value=><text x="540" y={230-205*value}>{value*100}%</text>)}<path d={rates.reduce((path,value,i)=>value===null?path:`${path} ${i===0||rates[i-1]===null?'M':'L'}${70+(i+.5)*step},${225-value*205}`,'')} stroke="#fb6a4a" stroke-width="2" fill="none" />{rates.map((value,i)=>value===null?null:<circle cx={70+(i+.5)*step} cy={225-value*205} r="3" fill="#fb6a4a"><title>{labels[i]}: {(value*100).toFixed(1)}% correct</title></circle>)}</g>}
    {[0, Math.floor((values.length - 1) / 2), values.length - 1].filter((v, i, a) => v >= 0 && a.indexOf(v) === i).map((i) => <text x={70 + (i + .5) * step} y="247" text-anchor="middle">{labels[i]}</text>)}
    {values.every((n) => !n) && <text class="chart-empty" x="300" y="125" text-anchor="middle">No data</text>}
  </svg></div>;
}
const duration = (ms: number) => ms < 60000 ? `${Math.round(ms / 1000)} seconds` : ms < 3600000 ? `${(ms / 60000).toFixed(1)} minutes` : `${(ms / 3600000).toFixed(1)} hours`;
const percent = (good: number, total: number) => total ? `${(100 * good / total).toFixed(1)}%` : '—';
function Graph({ title, subtitle, help, children }: { title: string; subtitle?: string; help: string; children: ComponentChildren }) {
  return <section class="stats-graph"><div class="graph-title"><h2>{title}</h2><span class="graph-help" tabIndex={0} title={help} aria-label={help}>ⓘ</span></div>{subtitle && <p class="graph-subtitle">{subtitle}</p>}{children}</section>;
}
function Range({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return <div class="graph-range">{[[31, '1 month'], [90, '3 months'], [365, '1 year'], [0, 'All time']].map(([days, text]) => <label><input type="radio" checked={value === days} onChange={() => onChange(Number(days))} />{text}</label>)}</div>;
}
function series(history: StudyDay[], days: number, time: boolean) {
  const rows = days ? history.slice(-days) : history;
  const step = rows.length > 120 ? Math.ceil(rows.length / 60) : 1;
  const values: number[] = [], labels: string[] = [];
  for (let i = 0; i < rows.length; i += step) { const bucket = rows.slice(i, i + step); values.push(bucket.reduce((sum, day) => sum + (time ? day.milliseconds / 60000 : day.count), 0)); labels.push(rows[i]!.date.slice(5)); }
  return { values, labels };
}
export function Statistics({ app, onMenu, onBrowse }: { app: AppController; onMenu: () => void; onBrowse: (query: string) => void }) {
  const [deck, setDeck] = useState<number | null>(Number(app.col.conf.curDeck) || null);
  const [days, setDays] = useState(365);
  const [reviewRange, setReviewRange] = useState(31);
  const [buttonRange, setButtonRange] = useState(31);
  const [selectedDay, setSelectedDay] = useState('');
  const [timeChart, setTimeChart] = useState(false);
  const data = useMemo(() => statistics(app.col, deck, days), [app.version, deck, days]);
  const buttonData = useMemo(() => statistics(app.col, deck, buttonRange), [app.version, deck, buttonRange]);
  const selected = data.calendar.find((day) => day.date === selectedDay);
  const categories = [
    ['New', data.cards.new, '#6baed6', 'is:new'], ['Learning', data.cards.learning, '#fd8d3c', 'is:learn -is:review'],
    ['Relearning', data.cards.relearning, '#fb6a4a', 'is:learn is:review'], ['Young', data.cards.young, '#74c476', 'is:review -is:learn prop:ivl<21'],
    ['Mature', data.cards.mature, '#31a354', 'is:review -is:learn prop:ivl>=21'], ['Suspended', data.cards.suspended, '#ffdc41', 'is:suspended'], ['Buried', data.cards.buried, 'grey', 'is:buried'],
  ] as const;
  const scope = deck ? `deck:"${app.col.deck(deck)?.name.replace(/"/g, '\\"')}" ` : '';
  const counts = categories.map(([, n]) => n), total = Math.max(1, data.cards.total);
  let angle = -Math.PI / 2;
  const pie = categories.map(([name, count, color]) => {
    const start = angle; angle += count / total * Math.PI * 2;
    const x1 = 100 + 95 * Math.cos(start), y1 = 100 + 95 * Math.sin(start), x2 = 100 + 95 * Math.cos(angle), y2 = 100 + 95 * Math.sin(angle);
    return count === data.cards.total ? <circle cx="100" cy="100" r="95" fill={color}><title>{name}: {count}</title></circle> : count > 0 ? <path d={`M100 100 L${x1} ${y1} A95 95 0 ${angle - start > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`} fill={color}><title>{name}: {count}</title></path> : null;
  });
  const history = series(reviewRange === 0 && days === 0 ? data.history : data.calendar, reviewRange, timeChart);
  const futureTotal = data.forecast.reduce((a, b) => a + b, 0);
  return <div class="screen statistics-screen"><Toolbar nav={{ icon: 'menu', label: 'Open menu', onClick: onMenu }}><select class="stats-deck-picker" aria-label="Statistics deck" value={deck ?? ''} onChange={(event) => setDeck(event.currentTarget.value ? Number(event.currentTarget.value) : null)}><option value="">Collection</option>{app.col.decksSorted().map((d) => <option value={d.id}>{d.name.replace(/::/g, ' › ')}</option>)}</select></Toolbar>
    <div class="stats-scroll">
      <div class="statistics-range"><div><label><input type="radio" checked={deck !== null} onChange={() => setDeck(Number(app.col.conf.curDeck) || 1)} />Deck</label><label><input type="radio" checked={deck === null} onChange={() => setDeck(null)} />Collection</label></div><div><label><input type="radio" checked={days === 365} onChange={() => setDays(365)} />Last year</label><label><input type="radio" checked={days === 0} onChange={() => setDays(0)} />All history</label></div></div>
      <main class="stats-graphs" aria-label="Statistics">
        <Graph title="Today" help="Answers recorded during this study day, using your collection’s rollover time."><div class="today-lines">
          {!data.today.answers ? <p>No cards have been studied today.</p> : <><p>Studied {data.today.answers} {data.today.answers === 1 ? 'card' : 'cards'} in {duration(data.today.milliseconds)} today<br />({(data.today.milliseconds / data.today.answers / 1000).toFixed(1)}s/card)</p><p>Again count: {data.today.again} ({percent(data.today.again, data.today.answers)})</p><p>Learn: {data.today.learning}, Review: {data.today.review}, Relearn: {data.today.relearning}, Filtered: {data.today.filtered}</p><p>{data.today.mature ? `Correct answers on mature cards: ${data.today.matureCorrect}/${data.today.mature} (${percent(data.today.matureCorrect, data.today.mature)})` : 'No mature cards were studied today.'}</p></>}
        </div></Graph>
        <Graph title="Future Due" subtitle="The number of reviews due in the future." help="Today includes overdue cards. This forecast excludes daily limits and cards you will introduce later."><BarChart label="Scheduled cards due in the next month" values={data.forecast} labels={data.forecast.map((_, i) => i === 0 ? 'Today' : `${i}`)} color={GREEN} /><div class="graph-summary">Total: {futureTotal} reviews<br />Average: {(futureTotal / 31).toFixed(1)} reviews/day<br />Due tomorrow: {data.forecast[1]}</div></Graph>
        <Graph title="Calendar" help="Tap a date to see answers and study time. Each square represents one study day."><div class="stats-calendar-months">{['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'].map((_, i) => <span>{new Date(`${data.calendar[Math.min(364, i * 30)]!.date}T12:00:00`).toLocaleDateString(undefined, {month:'short'})}</span>)}</div><div class="stats-calendar" role="group" aria-label="Study activity for the past year">{data.calendar.map((day) => <button type="button" class={`activity-day level-${day.count === 0 ? 0 : day.count < 10 ? 1 : day.count < 50 ? 2 : day.count < 100 ? 3 : 4}`} aria-label={`${day.date}: ${day.count} answers`} title={`${day.date}: ${day.count} answers`} onClick={() => setSelectedDay(day.date)} />)}</div><div class="graph-summary" aria-live="polite">{selected ? `${selected.date}: ${selected.count} answers in ${duration(selected.milliseconds)}` : `${data.currentStreak} day current streak · ${data.longestStreak} day longest streak`}<br />Days studied: {data.calendar.filter((d) => d.count).length} / 365</div></Graph>
        <Graph title="Reviews" subtitle="The number of questions you have answered." help="Includes learning, relearning and filtered reviews. Manual scheduling changes are excluded."><Range value={reviewRange} onChange={setReviewRange} /><div class="graph-range"><label><input type="radio" checked={!timeChart} onChange={() => setTimeChart(false)} />Count</label><label><input type="radio" checked={timeChart} onChange={() => setTimeChart(true)} />Time</label></div><BarChart label="Daily review history" {...history} /><div class="graph-summary">Total: {history.values.reduce((a,b)=>a+b,0).toFixed(timeChart ? 1 : 0)} {timeChart ? 'minutes' : 'reviews'}<br />Days studied: {data.period.daysStudied}</div></Graph>
        <Graph title="Card Counts" help="Mature cards have an interval of at least 21 days. Tap a type to open it in the browser."><div class="card-count-chart"><svg viewBox="0 0 200 200" role="img" aria-label={categories.map(([n,c])=>`${c} ${n}`).join(', ')}>{counts.some(Boolean) ? pie : <circle cx="100" cy="100" r="95" fill="var(--surface-variant)" />}</svg><table><tbody>{categories.map(([name, count, color, query]) => <tr><td><button type="button" onClick={() => onBrowse(scope + query + (name === 'Suspended' || name === 'Buried' ? '' : ' -is:suspended -is:buried'))}><i style={{background:color}} />{name}</button></td><td>{count.toLocaleString()}</td><td>{percent(count, data.cards.total)}</td></tr>)}<tr><th>Total</th><th>{data.cards.total.toLocaleString()}</th><th>100%</th></tr></tbody></table></div></Graph>
        <Graph title="Review Intervals" subtitle="The delay until reviews are shown again." help="Current intervals of review and relearning cards, including suspended cards."><BarChart label="Card interval distribution" values={data.intervals} labels={['≤1d', '≤7d', '≤21d', '≤30d', '≤90d', '≤180d', '≤1y', '>1y']} color={GREEN} /></Graph>
        {app.col.configBool('fsrs',false) && <Graph title="Card Stability" subtitle="The delay until recall probability drops to 90%." help="FSRS stability values, in days, for cards that have a memory state."><BarChart label="Card stability distribution" values={data.memory.stability} labels={['≤1d','≤7d','≤21d','≤30d','≤90d','≤180d','≤1y','>1y']} color={GREEN} /></Graph>}
        <Graph title="Card Ease" subtitle="The lower the ease, the more frequently a card will appear." help="SM-2 ease factors. New cards and FSRS-only cards without an ease factor are excluded."><BarChart label="Card ease distribution" values={data.ease} labels={data.ease.map((_,i) => `${130 + 25 * i}%`)} /></Graph>
        {app.col.configBool('fsrs',false) && <Graph title="Card Difficulty" subtitle="The higher the difficulty, the more slowly stability increases." help="FSRS difficulty on a 0–100% scale. New cards do not have a memory state yet."><BarChart label="Card difficulty distribution" values={data.memory.difficulty} labels={data.memory.difficulty.map((_,i)=>`${i*10}–${i*10+10}%`)} color="#fd8d3c" /></Graph>}
        {app.col.configBool('fsrs',false) && <Graph title="Card Retrievability" subtitle="The probability of recalling each card today." help="Calculated from each card’s stability, decay and last review time."><BarChart label="Card retrievability distribution" values={data.memory.retrievability} labels={data.memory.retrievability.map((_,i)=>`${i*10}–${i*10+10}%`)} color={GREEN} /><div class="graph-summary">Average: {percent(data.memory.averageRetrievability,1)}<br />Cards with memory states: {data.memory.count}</div></Graph>}
        <Graph title="True Retention" subtitle="The percentage of reviews you passed." help="Includes scheduling answers whose previous interval was at least one day, plus all regular review answers."><table class="retention-table"><thead><tr><th>Cards</th><th>Passed</th><th>Failed</th><th>Retention</th></tr></thead><tbody>{[['Young',data.retention.young],['Mature',data.retention.mature],['All',[data.retention.young[0]!+data.retention.mature[0]!,data.retention.young[1]!+data.retention.mature[1]!]]].map(([name, pair]) => { const [good,bad] = pair as number[]; return <tr><th>{name}</th><td>{good}</td><td>{bad}</td><td>{percent(good!,good!+bad!)}</td></tr>; })}</tbody></table></Graph>
        <Graph title="Hourly Breakdown" subtitle="Review success rate for each hour of the day." help="Answers grouped by your local clock. Counts include learning and review answers in the selected history period."><BarChart label="Answers by local hour" values={data.hours} labels={data.hours.map((_, i) => `${i}:00`)} rates={data.hours.map((count,i)=>count?data.hourlyCorrect[i]!/count:null)} /><div class="graph-summary">Total: {data.period.answers} answers in {duration(data.period.milliseconds)}</div></Graph>
        <Graph title="Answer Buttons" subtitle="The number of times you have pressed each button." help="Learning includes relearning. Young and mature use the interval before the answer."><Range value={buttonRange} onChange={setButtonRange} /><div class="answer-charts">{['Learning','Young','Mature'].map((name,i) => <div><BarChart label={`${name} answer buttons`} values={buttonData.answerGroups[i]!} labels={['Again','Hard','Good','Easy']} colors={['#fb6a4a','#fdae6b','#74c476','#6baed6']} /><div class="graph-summary">{name}</div></div>)}</div></Graph>
        <Graph title="Added" subtitle="The number of new cards you have added." help="Based on card creation dates. Imported cards retain their original creation dates."><BarChart label="Cards added over the past year" values={data.added} labels={data.calendar.map(d => d.date.slice(5))} /><div class="graph-summary">Total: {data.added.reduce((a,b)=>a+b,0)} cards</div></Graph>
      </main>
    </div></div>;
}
