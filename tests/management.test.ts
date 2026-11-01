// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Collection } from '../src/anki/collection';
import { saveNote, noteDuplicates, deleteNotes, setNoteTags } from '../src/anki/management/notes';
import { browse } from '../src/anki/management/search';
import { changeCards } from '../src/anki/management/cards';
import { statistics, studyDate } from '../src/anki/stats';
import { num } from '../src/anki/sqlite';
const model = (col: Collection,name='Basic') => Number(Object.values(col.models).find((model)=>model.name===name)!.id);
async function add(col:Collection,front='Bonjour',back='Hello',deckId=1,tags='French vocabulary') { return saveNote(col,{modelId:model(col),deckId,fields:[front,back],tags}); }

describe('local note management',()=>{
  it('generates basic/reversed/cloze cards and preserves scheduling while editing',async()=>{
    const col=await Collection.create(); const deck=col.addDeck('Languages::French');
    const note=await add(col,'Bonjour','Hello',deck); const original=col.nextCard(deck)!;
    col.answerCard(original.card.id,4,2000);
    const scheduled=col.getCard(original.card.id)!;
    await saveNote(col,{id:note.id,modelId:model(col),deckId:deck,fields:['<b>Bonjour!</b>','Hello!'],tags:'French French marked'});
    expect(col.getCard(original.card.id)).toEqual(scheduled);
    expect(col.getNote(note.id)!.tags).toBe(' French marked ');
    expect(col.getNote(note.id)!.sfld).toBe('Bonjour!');
    const reverse=await saveNote(col,{modelId:model(col,'Basic (and reversed card)'),deckId:deck,fields:['front','back'],tags:[]});
    expect(reverse.added).toBe(2);
    const cloze=await saveNote(col,{modelId:model(col,'Cloze'),deckId:deck,fields:['{{c1::Paris}} is in {{c3::France}}.',''],tags:[]});
    expect(cloze.added).toBe(2);
    expect(col.db.all('select ord from cards where nid=? order by ord',[cloze.id]).map((row)=>num(row[0]))).toEqual([0,2]);
    await saveNote(col,{id:cloze.id,modelId:model(col,'Cloze'),deckId:deck,fields:['{{c2::Europe}}',''],tags:[]});
    expect(col.db.all('select ord from cards where nid=? order by ord',[cloze.id]).map((row)=>num(row[0]))).toEqual([0,1,2]);
    col.db.close();
  });
  it('finds duplicates by normalized first-field checksum and can undo note edits/deletion',async()=>{
    const col=await Collection.create();const first=await add(col,'<b>Cat</b>','A feline');
    expect(noteDuplicates(col,model(col),'Cat')).toEqual([first.id]);
    const duplicate=await add(col,'Cat','Another feline');expect(duplicate.duplicate).toBe(true);
    col.undo();expect(col.noteCount()).toBe(1);
    deleteNotes(col,[first.id]);expect(col.cardCount()).toBe(0);expect(col.noteCount()).toBe(0);
    col.undo();expect(col.cardCount()).toBe(1);expect(col.getNote(first.id)?.flds).toBe('<b>Cat</b>\x1fA feline');
    col.db.close();
  });
  it('keeps a reversed template blank until its conditional field is filled',async()=>{
    const col=await Collection.create(); const optional=Object.values(col.models).find((m)=>m.name==='Basic (optional reversed card)')!;
    const saved=await saveNote(col,{modelId:Number(optional.id),deckId:1,fields:['front','back',''],tags:[]});expect(saved.added).toBe(1);
    const changed=await saveNote(col,{id:saved.id,modelId:Number(optional.id),deckId:1,fields:['front','back','yes'],tags:[]});expect(changed.added).toBe(1);
    col.db.close();
  });
});
describe('browser search and bulk actions',()=>{
  it('supports scoped, quoted, boolean, field and numeric searches without SQL injection',async()=>{
    const col=await Collection.create();const deck=col.addDeck('Languages::French');
    await add(col,'Bonjour world','Hello world',deck,'French marked');await add(col,'Guten Tag','Hello',1,'German');
    expect(browse(col,'deck:Languages').total).toBe(1);
    expect(browse(col,'(tag:French OR tag:German) -is:suspended').total).toBe(2);
    expect(browse(col,'Front:"Bonjour world"').total).toBe(1);
    expect(browse(col,'note:Basic is:new prop:reps=0').total).toBe(2);
    expect(browse(col,"' OR 1=1 --").total).toBe(0);
    expect(()=>browse(col,'(tag:French')).toThrow(/Close/);
    const cards=browse(col,'tag:French').rows.map((row)=>row.id);changeCards(col,cards,'suspend');expect(browse(col,'is:suspended').total).toBe(1);
    col.undo();expect(browse(col,'is:suspended').total).toBe(0);
    changeCards(col,cards,{flag:3});expect(browse(col,'flag:3').total).toBe(1);
    setNoteTags(col,browse(col,'flag:3').rows.map((row)=>row.noteId),['important'],['marked']);expect(browse(col,'tag:important -is:marked').total).toBe(1);
    col.db.close();
  });
});
describe('statistics',()=>{
  it('counts answer events, excludes manual changes, scopes to subdecks, and retains deleted-card history',async()=>{
    const now=new Date(2026,6,4,12,0).getTime();const col=await Collection.create(Math.floor(now/1000));const deck=col.addDeck('Languages::French');const note=await add(col,'A','B',deck);
    const next=col.nextCard(deck,Math.floor(now/1000))!;col.answerCard(next.card.id,4,3000,now-1000);
    const other=await add(col,'C','D');const card=col.db.first('select id from cards where nid=?',[other.id])!;
    col.db.exec('insert into revlog values (?,?,-1,0,1,1,2500,1000,4)',[now-500,num(card[0])]);
    const stats=statistics(col,null,31,now);expect(stats.today.answers).toBe(1);expect(stats.today.cards).toBe(1);expect(stats.today.milliseconds).toBe(3000);expect(stats.period.answers).toBe(1);expect(stats.answers).toEqual([0,0,0,1]);expect(stats.currentStreak).toBe(1);
    expect(statistics(col,col.deckByName('Languages')!.id,31,now).cards.total).toBe(1);
    expect(statistics(col,1,31,now).today.answers).toBe(0);
    deleteNotes(col,[note.id]);expect(statistics(col,null,31,now).today.answers).toBe(1);expect(statistics(col,null,31,now).cards.total).toBe(1);
    col.db.close();
  });
  it('assigns answers before rollover to the previous calendar day',()=>{
    expect(studyDate(new Date(2026,6,4,3,59).getTime(),4)).toBe('2026-07-03');
    expect(studyDate(new Date(2026,6,4,4,0).getTime(),4)).toBe('2026-07-04');
  });
});

describe('deck options and hierarchy',()=>{
  it('renames whole subtrees, rejects collisions and cycles, and restores deletions with sibling notes intact',async()=>{
    const {renameDeck,deleteDeck}=await import('../src/anki/management/decks');const col=await Collection.create();
    const child=col.addDeck('Languages::French');const parent=col.deckByName('Languages')!.id;
    const note=await saveNote(col,{modelId:model(col,'Basic (and reversed card)'),deckId:child,fields:['Bonjour','Hello'],tags:[]});
    const cards=browse(col,`nid:${note.id}`).rows;changeCards(col,[cards[1]!.id],{deck:1});
    renameDeck(col,parent,'Study::Languages');expect(col.deck(child)?.name).toBe('Study::Languages::French');
    expect(()=>renameDeck(col,parent,'Study::Languages::French::Bad')).toThrow(/inside itself/);
    col.addDeck('Other');expect(()=>renameDeck(col,parent,'Other')).toThrow(/already exists/);
    expect(deleteDeck(col,parent)).toEqual({cards:1,notes:0});expect(col.getNote(note.id)).not.toBeNull();expect(col.cardCount()).toBe(1);
    col.undo();expect(col.cardCount()).toBe(2);expect(col.deck(child)?.name).toBe('Study::Languages::French');
    col.undo();expect(col.deck(parent)?.name).toBe('Languages');expect(col.deckByName('Study')).toBeNull();col.db.close();
  });
  it('parses step units and saves shared presets with effective deck/today overrides',async()=>{
    const {parseSteps,formatSteps,saveDeckOptions,clonePreset,deletePreset}=await import('../src/anki/management/decks');const col=await Collection.create();
    expect(parseSteps('30s 1m 2h 1d')).toEqual([.5,1,120,1440]);expect(formatSteps([.5,1,120,1440])).toBe('30s 1m 2h 1d');expect(()=>parseSteps('-1m')).toThrow();
    const id=clonePreset(col,1,'Language preset');const preset=structuredClone(col.dconf[String(id)]);preset.new.perDay=5;preset.new.delays=[.5,2];
    const today=col.timing().daysElapsed;saveDeckOptions(col,1,id,preset,{newLimit:3,newLimitToday:{limit:7,today}});
    expect(col.configForDeck(1).newPerDay).toBe(5);expect(col.deckTree().children[0]?.newCount??0).toBe(0);expect(col.deck(1)?.newLimitToday?.limit).toBe(7);
    expect(()=>saveDeckOptions(col,1,id,preset,{reviewLimitToday:{limit:-1,today}})).toThrow(/Today/);
    deletePreset(col,id);expect(col.deck(1)?.configId).toBe(1);col.undo();expect(col.deck(1)?.configId).toBe(id);expect(col.dconf[String(id)]).toBeDefined();col.db.close();
  });
});
