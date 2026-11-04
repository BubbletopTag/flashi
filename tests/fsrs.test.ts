// SPDX-License-Identifier: AGPL-3.0-or-later
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {describe,it,expect} from 'vitest';
import {Collection,cardToRow,CARD_COLUMNS} from '../src/anki/collection';
import {parseDeckConfig} from '../src/anki/config';
import {fsrsContext} from '../src/anki/scheduler/fsrs';
import {nextStatesFor,applyAnswer,stateForRating} from '../src/anki/scheduler/answering';
import {intervalKind,type CardState} from '../src/anki/scheduler/states';
import {saveNote} from '../src/anki/management/notes';
import {parseCardData} from '../src/anki/model';
const python=process.env.FLASHI_ANKI_PYTHON??'python3';let haveAnki=false;try{execFileSync(python,['-c','import anki'],{stdio:'ignore'});haveAnki=true;}catch{}

describe('FSRS scheduling',()=>{
  it('writes memory states, retention, history and undo without affecting custom card data',async()=>{
    const col=await Collection.create();col.setConf('fsrs',true);col.setConf('loadBalancerEnabled',false);
    const mid=Number(Object.values(col.models).find(model=>model.name==='Basic')!.id);const note=await saveNote(col,{modelId:mid,deckId:1,fields:['Q','A'],tags:[]});
    const next=col.nextCard(1)!;const before=col.getCard(next.card.id)!;before.data=JSON.stringify({cd:'{"custom":1}'});col.updateCard(before);
    const after=col.answerCard(before.id,4,1500);const memory=parseCardData(after.data);expect(memory.s).toBeGreaterThan(0);expect(memory.d).toBeGreaterThanOrEqual(1);expect(memory.dr).toBe(.9);expect(memory.cd).toBe('{"custom":1}');expect(after.type).toBe(2);expect(after.ivl).toBeGreaterThan(1);expect(col.getNote(note.id)).not.toBeNull();
    col.undo();expect(col.getCard(before.id)).toEqual(before);col.db.close();
  });
  it.skipIf(!haveAnki)('matches official Anki intervals and memory states for new/learn/review/relearn and empty steps',async()=>{
    const golden=JSON.parse(execFileSync(python,[resolve('scripts/fsrs-golden.py')],{encoding:'utf8'}));
    const col=await Collection.create();col.crt=golden.crt;col.conf=golden.conf;
    for(const s of golden.scenarios){
      col.dconf['1']=s.config;col.db.exec(`insert or replace into cards (${CARD_COLUMNS}) values (${Array(18).fill('?').join(',')})`,cardToRow(s.card));
      const fsrs=fsrsContext(col,s.card,s.timing.nextDayAt)!;const ctx={config:parseDeckConfig(s.config),timing:s.timing,now:s.now,fsrs};const states=nextStatesFor(s.card,ctx);
      for(const [i,key] of ['again','hard','good','easy'].entries()){
        const ours=states[key as 'again'];const official=s.states[key].normal;const core=official.review??official.learning??official.relearning?.learning;
        const kind=intervalKind(ours);const expected=core.scheduled_days!==undefined?{days:core.scheduled_days}:{secs:core.scheduled_secs};
        expect(kind,`${s.kind} ${key} interval`).toEqual(expected);
        const result=applyAnswer(s.card,states.current,stateForRating(states,i+1),i+1,s.now*1000,1000,ctx);const memory=parseCardData(result.card.data);
        const officialMemory=core.memory_state??official.relearning?.review.memory_state;
        expect(memory.s,`${s.kind} ${key} stability`).toBeCloseTo(officialMemory.stability,3);expect(memory.d,`${s.kind} ${key} difficulty`).toBeCloseTo(officialMemory.difficulty,3);
      }
    }col.db.close();
  });
});
