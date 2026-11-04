// SPDX-License-Identifier: AGPL-3.0-or-later
// FSRS memory updates: ts-fsrs (MIT). Anki state/step/fuzz integration follows
// rslib/src/scheduler/states/{learning,review,relearning}.rs (Ankitects et al).
import { FSRSAlgorithm, default_w, type FSRSState } from 'ts-fsrs';
import type { Collection } from '../collection';
import type { Card } from '../model';
import { parseCardData } from '../model';
import type { Json } from '../config';
import { num } from '../sqlite';
import { f32 } from '../rng';
import { constrainedFuzzBounds, ctxFuzz, leechThresholdMet, minAndMaxReviewIntervals, roundF32, type CardState, type LearnState, type ReviewState, type SchedulingStates, type StateContext } from './states';
export interface FsrsItem { memory: FSRSState; interval: number }
export interface FsrsContext { items: FsrsItem[]; retention: number; decay: number; allowShortTerm: boolean }
const clamp=(n:number,min:number,max:number)=>Math.min(max,Math.max(min,n));
export function parameters(raw:Json):number[]{
  for(const key of ['fsrsParams6','fsrsParams5','fsrsWeights'])if(Array.isArray(raw?.[key])&&raw[key].length)return raw[key];
  return [...default_w];
}
export function fsrsAlgorithm(raw:Json,retention=Number(raw?.desiredRetention??.9)):FSRSAlgorithm{
  const weights=parameters(raw);
  if(![17,19,21].includes(weights.length))throw new Error('This preset uses an unsupported FSRS model. Choose FSRS-4.5, 5 or 6 parameters.');
  return new FSRSAlgorithm({w:weights,request_retention:clamp(retention,.7,.99),enable_fuzz:false,enable_short_term:weights.length>=19,maximum_interval:Number(raw?.rev?.maxIvl??36500)});
}
export function sm2Memory(algorithm:FSRSAlgorithm,card:Card,retention:number):FSRSState{
  const w=algorithm.parameters.w,decay=-w[20]!;
  const factor=Math.exp(Math.log(.9)/decay)-1;
  const stability=clamp(card.ivl*factor/(Math.pow(clamp(retention,.7,.99),1/decay)-1),.001,36500);
  const difficulty=clamp(11-(Math.max(1.3,card.factor/1000)-1)/(Math.exp(w[8]!)*Math.pow(stability,-w[9]!)*Math.expm1(w[10]!*(1-retention))),1,10);
  return {stability:f32(stability),difficulty:f32(difficulty)};
}
export function fsrsContext(col:Collection,card:Card,nextDayAt:number):FsrsContext|undefined{
  if(!col.configBool('fsrs',false))return undefined;
  const raw=col.dconf[String(col.deck(card.odid||card.did)?.configId??1)]??{};
  const override=Number(col.decksJson[String(card.odid||card.did)]?.desiredRetention??0);
  const retention=override>0?override/100:Number(raw.desiredRetention??.9);
  const algorithm=fsrsAlgorithm(raw,retention),data=parseCardData(card.data);
  const w=algorithm.parameters.w;
  const daysSince=(seconds:number)=>Math.max(0,Math.floor((nextDayAt-seconds)/86400));
  let memory:FSRSState|null=typeof data.s==='number'&&data.s>0&&typeof data.d==='number'&&data.d>=1?{stability:data.s,difficulty:data.d}:null;
  let last=data.lrt??0;
  if(card.type!==0&&!memory){
    const cutoff=raw.ignoreRevlogsBeforeDate?new Date(`${raw.ignoreRevlogsBeforeDate}T00:00:00`).getTime():0;
    const logs=col.db.all('select id,ease,type,lastIvl,factor from revlog where cid=? and id>=? order by id',[card.id,Number.isFinite(cutoff)?cutoff:0]);
    let previousDay:number|null=null;
    for(const row of logs){
      const id=num(row[0]),rating=num(row[1]),kind=num(row[2]);
      // Forget/reschedule entries reset the inferred history. A following
      // scheduling answer can still initialize from the old SM-2 interval.
      if(rating===0){if(kind===4)memory=null;continue;}
      if(rating<1||rating>4||kind>3)continue;
      if(!memory&&kind!==0&&num(row[3])>0)memory=sm2Memory(algorithm,{...card,ivl:num(row[3]),factor:num(row[4])||card.factor},Number(raw.sm2Retention??.9));
      const day=daysSince(id/1000);
      memory=algorithm.next_state(memory,previousDay===null?0:Math.max(0,previousDay-day),rating);
      previousDay=day;last=id/1000;
    }
    memory??=card.ivl>0?sm2Memory(algorithm,card,Number(raw.sm2Retention??.9)):null;
  }
  if(!last)last=num(col.db.scalar('select max(id)/1000 from revlog where cid=? and ease between 1 and 4 and type between 0 and 3',[card.id]));
  const elapsed=last?daysSince(last):0;
  const modifier=algorithm.interval_modifier;
  const items=[1,2,3,4].map(rating=>{const next=algorithm.next_state(memory,elapsed,rating);const updated={stability:f32(next.stability),difficulty:f32(next.difficulty)};return {memory:updated,interval:f32(updated.stability*modifier)};});
  return {items,retention,decay:f32(w[20]!),allowShortTerm:parameters(raw).length>=19&&w[17]!>0&&w[18]!>0};
}
export function fsrsNextStates(state:CardState,ctx:StateContext,fsrs:FsrsContext):SchedulingStates{
  const fuzz=(interval:number,minimum=1)=>{const [min,max]=minAndMaxReviewIntervals(ctx,minimum);return ctxFuzz(ctx,f32(interval),min,max);};
  const item=(rating:number)=>fsrs.items[rating-1]!;
  const memory=(rating:number)=>item(rating).memory;
  const review=(rating:number,interval:number,previous?:ReviewState):ReviewState=>({kind:'review',scheduledDays:interval,elapsedDays:0,easeFactor:previous?.easeFactor??ctx.initialEaseFactor,lapses:previous?.lapses??0,leeched:false,memory:memory(rating)});
  const graduating=(rating:number,remaining:number,previous?:ReviewState):CardState=>{
    const interval=item(rating).interval;
    const next=review(rating,fuzz(Math.max(1,roundF32(interval))),previous);
    if(rating!==4&&fsrs.allowShortTerm&&interval<.5){const learning:LearnState={kind:'learning',remainingSteps:remaining,scheduledSecs:Math.max(1,Math.floor(f32(interval*86400))),elapsedSecs:0,memory:memory(rating)};return previous?{kind:'relearning',learning,review:next}:learning;}
    return next;
  };
  const learn=(learning:LearnState,previous?:ReviewState):CardState[]=>{
    const steps=previous?ctx.relearnSteps:ctx.steps;
    return [1,2,3,4].map(rating=>{
      const interval=item(rating).interval;
      if(rating===4){const good=fuzz(item(3).interval);return review(4,fuzz(Math.max(1,roundF32(interval)),good+1),previous);}
      const delay=rating===1?steps.againDelaySecsLearn():rating===2?steps.hardDelaySecs(learning.remainingSteps):steps.goodDelaySecs(learning.remainingSteps);
      const remaining=rating===1?steps.remainingForFailed():rating===3?steps.remainingForGood(learning.remainingSteps):learning.remainingSteps;
      if(delay===null)return graduating(rating,remaining,previous);
      const next:LearnState={kind:'learning',remainingSteps:remaining,scheduledSecs:delay,elapsedSecs:0,memory:memory(rating)};
      return previous?{kind:'relearning',learning:next,review:{...previous,elapsedDays:0,scheduledDays:rating===1?Math.max(1,roundF32(interval)):previous.scheduledDays,memory:memory(rating)}}:next;
    });
  };
  let outcomes:CardState[];
  if(state.kind==='new')outcomes=learn({kind:'learning',remainingSteps:ctx.steps.remainingForFailed(),scheduledSecs:0,elapsedSecs:0});
  else if(state.kind==='learning')outcomes=learn(state);
  else if(state.kind==='relearning')outcomes=learn(state.learning,state.review);
  else{
    const fail=item(1).interval,lapses=state.lapses+1;
    const failed:ReviewState={...review(1,Math.max(1,roundF32(fail)),state),easeFactor:Math.max(f32(state.easeFactor-.2),f32(1.3)),lapses,leeched:leechThresholdMet(lapses,ctx.leechThreshold)};
    const delay=ctx.relearnSteps.againDelaySecsLearn();
    const again:CardState=delay!==null||fsrs.allowShortTerm&&ctx.relearnSteps.isEmpty()&&fail<.5?{kind:'relearning',review:failed,learning:{kind:'learning',remainingSteps:ctx.relearnSteps.remainingForFailed(),scheduledSecs:delay??Math.max(1,Math.floor(f32(fail*86400))),elapsedSecs:0,memory:memory(1)}}:failed;
    let last=0;
    const passing=[2,3,4].map(rating=>{
      const interval=item(rating).interval;
      const [,upper]=constrainedFuzzBounds(interval,1,ctx.maximumReviewInterval);
      const minimum=roundF32(interval)>state.scheduledDays?state.scheduledDays+1:state.scheduledDays<=upper?state.scheduledDays:0;
      const days=fuzz(interval,Math.max(rating===2?1:last+1,minimum));last=days;
      const next=review(rating,days,state);next.easeFactor=rating===2?Math.max(f32(state.easeFactor-.15),f32(1.3)):rating===4?f32(state.easeFactor+.15):state.easeFactor;return next;
    });outcomes=[again,...passing];
  }
  return {current:state,again:outcomes[0]!,hard:outcomes[1]!,good:outcomes[2]!,easy:outcomes[3]!};
}
