#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Live FSRS scenarios from official Anki, consumed by tests/fsrs.test.ts."""
import json, os, tempfile, time
from anki.collection import Collection
from google.protobuf.json_format import MessageToDict
col=Collection(os.path.join(tempfile.mkdtemp(), 'collection.anki2'))
col.set_config('fsrs',True)
col.set_config('loadBalancerEnabled',False)
model=col.models.by_name('Basic')
scenarios=[]
cols='id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data'
for kind in ['new','review','learning','relearning','sm2_bridge','no_steps_new','no_steps_review','no_steps_relearning']:
    cfg=col.decks.config_dict_for_deck_id(1)
    cfg['new']['delays']=[] if kind.startswith('no_steps') else [1,10]
    cfg['lapse']['delays']=[] if kind.startswith('no_steps') else [10]
    col.decks.update_config(cfg)
    note=col.new_note(model);note['Front']=kind;note['Back']='answer';col.add_note(note,1)
    cid=note.cards()[0].id
    now=int(time.time());today=col.sched.today
    if 'review' in kind or kind=='sm2_bridge':
        data='' if kind=='sm2_bridge' else json.dumps({'s':10.0,'d':5.0,'lrt':now-7*86400,'dr':.9,'decay':.1542})
        col.db.execute('update cards set type=2,queue=2,ivl=7,due=?,factor=2500,reps=10,data=? where id=?',today,data,cid)
    elif kind=='learning':
        col.db.execute('update cards set type=1,queue=1,due=?,left=1,reps=1,data=? where id=?',now-1,json.dumps({'s':1.2,'d':5.,'lrt':now-60}),cid)
    elif 'relearning' in kind:
        col.db.execute('update cards set type=3,queue=1,ivl=3,due=?,factor=2300,left=1,lapses=1,reps=15,data=? where id=?',now-1,json.dumps({'s':3.,'d':6.,'lrt':now-60}),cid)
    card=dict(zip(cols.split(','),col.db.first('select '+cols+' from cards where id=?',cid)))
    states=col._backend.get_scheduling_states(cid)
    scenarios.append({'kind':kind,'card':card,'config':cfg,'now':int(time.time()),'timing':{'daysElapsed':today,'nextDayAt':col.sched.day_cutoff},'states':MessageToDict(states,preserving_proto_field_name=True,always_print_fields_with_no_presence=True)})
print(json.dumps({'crt':col.crt,'conf':{key:col.get_config(key,default) for key,default in [('fsrs',True),('schedVer',2),('curDeck',1),('rollover',4),('creationOffset',None)]},'scenarios':scenarios}))
