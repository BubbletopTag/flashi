// SPDX-License-Identifier: AGPL-3.0-or-later
import { CARD_COLUMNS, NOTE_COLUMNS, nowSecs, type Collection } from '../collection';
import type { Json } from '../config';
import { deckIds } from '../scope';
import { num } from '../sqlite';

function changed(col: Collection) { col.markJsonDirty(); col.invalidateQueue(); }
export function renameDeck(col: Collection, id: number, input: string): void {
  const deck = col.deck(id); if (!deck) throw new Error('That deck no longer exists.');
  const name = input.split('::').map((part) => part.trim().normalize('NFC')).filter(Boolean).join('::');
  if (!name) throw new Error('Enter a deck name.');
  if (name.toLowerCase().startsWith(deck.name.toLowerCase() + '::')) throw new Error('A deck cannot be moved inside itself.');
  const before = structuredClone(col.decksJson);
  const subtree = new Set(deckIds(col, id));
  const updates = col.decksSorted().filter((item) => subtree.has(item.id)).map((item) => ({id:item.id, name:name + item.name.slice(deck.name.length)}));
  for (const update of updates) { const duplicate=col.deckByName(update.name); if (duplicate && !subtree.has(duplicate.id)) throw new Error(`A deck named “${update.name}” already exists.`); }
  const parts = name.split('::'); if(parts.length > 1) { const parent = col.deckByName(parts.slice(0,-1).join('::')); if (parent?.filtered) throw new Error('A filtered deck cannot contain subdecks.'); col.addDeck(parts.slice(0,-1).join('::')); }
  for (const update of updates) Object.assign(col.decksJson[String(update.id)], {name:update.name,mod:nowSecs(),usn:-1});
  changed(col); col.registerUndo('Rename deck', () => { col.decksJson=before; changed(col); });
}
export function deleteDeck(col: Collection, id: number): { cards: number; notes: number } {
  const ids=deckIds(col,id); if(!ids.length)throw new Error('That deck no longer exists.');
  const before=structuredClone(col.decksJson), conf=structuredClone(col.conf);
  const placeholders=ids.map(()=>'?').join(',');
  const cards=col.db.all(`select ${CARD_COLUMNS} from cards where did in (${placeholders}) or odid in (${placeholders})`,[...ids,...ids]);
  const noteIds=[...new Set(cards.map(row=>num(row[1])))];
  const notes=noteIds.flatMap(nid=>col.db.all(`select ${NOTE_COLUMNS} from notes where id=?`,[nid]));
  const graves:number[]=[]; let removedCards=0, removedNotes=0;
  const grave=(oid:number,type:number)=>{col.db.exec('insert into graves values (-1,?,?)',[oid,type]);graves.push(num(col.db.scalar('select last_insert_rowid()')));};
  col.db.transaction(()=>{
    for(const row of cards) {
      const cid=num(row[0]), home=num(row[15]);
      if(home && !ids.includes(home)) { const card=col.getCard(cid)!; card.did=home;card.due=card.odue;card.odid=0;card.odue=0;card.mod=nowSecs();card.usn=-1;col.updateCard(card); }
      else {col.db.exec('delete from cards where id=?',[cid]);grave(cid,0);removedCards++;}
    }
    for(const nid of noteIds) if(!col.db.scalar('select 1 from cards where nid=?',[nid])) {col.db.exec('delete from notes where id=?',[nid]);grave(nid,1);removedNotes++;}
    for(const did of ids) {if(did===1){Object.assign(col.decksJson['1'],{name:'Default',dyn:0,collapsed:false});}else{delete col.decksJson[String(did)];grave(did,2);}}
  });
  if(ids.includes(col.currentDeckId())){col.conf.curDeck=1;col.conf.activeDecks=[1];}
  changed(col);col.registerUndo('Delete deck',()=>{
    col.decksJson=before;col.conf=conf;
    for(const row of notes)col.db.exec(`insert or replace into notes (${NOTE_COLUMNS}) values (${Array(11).fill('?').join(',')})`,row);
    for(const row of cards)col.db.exec(`insert or replace into cards (${CARD_COLUMNS}) values (${Array(18).fill('?').join(',')})`,row);
    for(const rowid of graves)col.db.exec('delete from graves where rowid=?',[rowid]);changed(col);
  });return {cards:removedCards,notes:removedNotes};
}
export function saveDeckOptions(col:Collection,deckId:number,presetId:number,preset:Json,deckOptions:Json):void {
  const deck=col.deck(deckId);if(!deck || deck.filtered)throw new Error('Choose a normal deck.');
  if(!col.dconf[String(presetId)])throw new Error('That preset no longer exists.');
  const previousDeck=structuredClone(col.decksJson[String(deckId)]),previousPreset=structuredClone(col.dconf[String(presetId)]);
  const validLimit=(value:unknown)=>value===null || (Number.isInteger(value)&&Number(value)>=0&&Number(value)<=999999);
  for(const value of [preset.new?.perDay,preset.rev?.perDay])if(!validLimit(value)||value===null)throw new Error('Daily limits must be whole numbers from 0 to 999999.');
  for(const key of ['newLimit','reviewLimit'])if(!validLimit(deckOptions[key]??null))throw new Error('Deck limits must be blank or a non-negative whole number.');
  for(const key of ['newLimitToday','reviewLimitToday'])if(deckOptions[key] && !validLimit(deckOptions[key].limit))throw new Error('Today’s limits must be non-negative whole numbers.');
  const numbers:Array<[unknown,number,number,string]>=[
    [preset.new.ints[0],1,36500,'Graduating interval'],[preset.new.ints[1],1,36500,'Easy interval'],[preset.new.initialFactor,1300,10000,'Starting ease'],
    [preset.rev.maxIvl,1,36500,'Maximum interval'],[preset.rev.ivlFct,.1,10,'Interval modifier'],[preset.rev.hardFactor,1,10,'Hard interval'],[preset.rev.ease4,1,10,'Easy bonus'],
    [preset.lapse.mult,0,1,'New interval'],[preset.lapse.minInt,1,36500,'Minimum interval'],[preset.lapse.leechFails,0,9999,'Leech threshold'],[preset.maxTaken,0,3600,'Maximum answer time'],
  ];
  for(const [value,min,max,label] of numbers)if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error(`${label} is outside the allowed range.`);
  for(const value of [...preset.new.delays,...preset.lapse.delays])if(!Number.isFinite(value)||value<=0)throw new Error('Learning steps must be positive durations.');
  if(!preset.name?.trim())throw new Error('Enter a preset name.');
  col.dconf[String(presetId)]={...structuredClone(preset),id:presetId,mod:nowSecs(),usn:-1};
  Object.assign(col.decksJson[String(deckId)],deckOptions,{conf:presetId,mod:nowSecs(),usn:-1});
  changed(col);col.registerUndo('Change deck options',()=>{col.decksJson[String(deckId)]=previousDeck;col.dconf[String(presetId)]=previousPreset;changed(col);});
}
export function clonePreset(col:Collection,source:number,name:string):number {
  if(!name.trim())throw new Error('Enter a preset name.');if(!col.dconf[String(source)])throw new Error('Preset unavailable.');
  if(Object.values(col.dconf).some(preset=>String(preset.name).toLowerCase()===name.trim().toLowerCase()))throw new Error('A preset with that name already exists.');
  let id=Date.now();while(col.dconf[String(id)])id++;
  col.dconf[String(id)]={...structuredClone(col.dconf[String(source)]),id,name:name.trim(),mod:nowSecs(),usn:-1};
  changed(col);col.registerUndo('Create preset',()=>{delete col.dconf[String(id)];changed(col);});return id;
}
export function deletePreset(col:Collection,id:number):void {
  if(id===1)throw new Error('The Default preset cannot be deleted.');
  const previous=structuredClone(col.dconf[String(id)]),decks=structuredClone(col.decksJson);
  if(!previous)throw new Error('Preset unavailable.');delete col.dconf[String(id)];
  for(const raw of Object.values(col.decksJson))if(raw.conf===id){raw.conf=1;raw.mod=nowSecs();raw.usn=-1;}
  changed(col);col.registerUndo('Delete preset',()=>{col.dconf[String(id)]=previous;col.decksJson=decks;changed(col);});
}
export function parseSteps(input:string):number[] {
  if(!input.trim())return [];
  return input.trim().split(/\s+/).map(value=>{const match=/^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(value);if(!match)throw new Error('Use steps such as 1m 10m or 30s 1h.');const minutes=Number(match[1])*({s:1/60,m:1,h:60,d:1440}[match[2]??'m']!);if(minutes<=0||minutes>36500*1440)throw new Error('Learning steps must be positive durations.');return minutes;});
}
export function formatSteps(values:number[]):string{return values.map(value=>value<1?`${Math.round(value*60)}s`:value%1440===0?`${value/1440}d`:value%60===0?`${value/60}h`:`${value}m`).join(' ');}
