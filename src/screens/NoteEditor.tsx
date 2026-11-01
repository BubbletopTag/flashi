// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMemo, useRef, useState } from 'preact/hooks';
import type { AppController } from '../app/controller';
import { Dialog, IconButton, TextButton, Toolbar } from '../app/ui';
import { saveNote, noteDuplicates } from '../anki/management/notes';
import { escapeAttribute } from '../anki/template/text';
import { sha1Hex } from '../anki/sha1';
import { renderNoteContent } from '../anki/template/render';
import { CardPreview } from './CardPreview';
import { clearMediaCache } from '../app/cardFrame';
import type { Card } from '../anki/model';

export function NoteEditor({ app, noteId, onBack, onSaved }: { app: AppController; noteId?: number; onBack: () => void; onSaved: (id: number) => void }) {
  const note = useMemo(() => noteId ? app.col.getNote(noteId) : null, [noteId]);
  const models = Object.values(app.col.models).filter((model) => model.name !== 'Image Occlusion').sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  const [modelId,setModelId] = useState(note?.mid ?? Number(app.col.conf.curModel ?? models.find((m)=>m.name==='Basic')?.id ?? models[0]?.id));
  const model = app.col.model(modelId);
  const firstCard = noteId ? app.col.db.first('select id,case when odid!=0 then odid else did end from cards where nid=? order by ord limit 1',[noteId]) : null;
  const [deckId,setDeckId]=useState(Number(firstCard?.[1] ?? (app.col.deck(app.col.currentDeckId())?.filtered ? 1 : app.col.currentDeckId())));
  const original = note?.flds.split('\x1f') ?? model?.flds.map(()=> '');
  const [fields,setFields]=useState<string[]>(original ?? []);
  const [tags,setTags]=useState(note?.tags.trim() ?? '');
  const [error,setError]=useState(''); const [status,setStatus]=useState(''); const [busy,setBusy]=useState(false);
  const [active,setActive]=useState(0); const [discard,setDiscard]=useState(false); const [preview,setPreview]=useState(false);
  const inputs=useRef<Array<HTMLTextAreaElement|null>>([]); const mediaInput=useRef<HTMLInputElement>(null);
  const baseline=useRef({fields:[...fields],tags,deckId,modelId});
  const dirty=fields.some((value,i)=>value !== (baseline.current.fields[i]??'')) || tags !== baseline.current.tags || deckId !== baseline.current.deckId || modelId !== baseline.current.modelId;
  const duplicates=useMemo(()=>fields[0]?.trim()?noteDuplicates(app.col,modelId,fields[0],noteId):[],[fields[0],modelId,noteId,app.version]);
  const update=(index:number,value:string)=>setFields((old)=>old.map((field,i)=>i===index?value:field));
  const wrap=(before:string,after:string)=>{
    const input=inputs.current[active]; if(!input)return;
    const start=input.selectionStart,end=input.selectionEnd;const field=fields[active]??'';
    update(active,field.slice(0,start)+before+field.slice(start,end)+after+field.slice(end));
    requestAnimationFrame(()=>{input.focus();input.setSelectionRange(start+before.length,end+before.length);});
  };
  const attach=async(file:File)=>{
    setBusy(true);setError('');
    try {
      if(file.size>100*1024*1024)throw new Error('Choose an attachment smaller than 100 MB.');
      let name=file.name.replace(/[\\/\x00]/g,'_').normalize('NFC'); const exists=await app.store.media.get(name);
      if(exists&&(await sha1Hex(exists))!==(await sha1Hex(file))){const dot=name.lastIndexOf('.');const hash=(await sha1Hex(file)).slice(0,8);name=dot>0?name.slice(0,dot)+'-'+hash+name.slice(dot):name+'-'+hash;}
      await app.store.media.put(name,file);clearMediaCache();
      const image=file.type.startsWith('image/')||/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name);
      const video=file.type.startsWith('video/')||/\.(mp4|webm|mov)$/i.test(name);
      const markup=image?`<img src="${escapeAttribute(name)}">`:video?`<video controls src="${escapeAttribute(name)}"></video>`:`[sound:${name}]`;
      update(active,(fields[active]??'')+markup);setStatus(`Attached ${name}`);
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  };
  const save=async()=>{
    if(busy)return;
    setBusy(true);setError('');setStatus('');
    try {
      const result=await saveNote(app.col,{id:noteId,modelId,deckId,fields,tags});app.changed();await app.saveNow();
      if(app.saveError)throw new Error(`The note is in memory but couldn't be saved: ${app.saveError}. Export a backup.`);
      if(noteId)onSaved(result.id);
      else { const nextFields=fields.map((field,i)=>model.flds[i]?.sticky?field:'');baseline.current={fields:nextFields,tags,deckId,modelId};setFields(nextFields);setStatus(`Added ${result.added} ${result.added===1?'card':'cards'}${result.duplicate?' (duplicate first field)':''}.`);inputs.current[0]?.focus(); }
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  };
  const draftCard:Card={id:Number(firstCard?.[0]??0),nid:noteId??0,did:deckId,ord:0,mod:0,usn:-1,type:0,queue:0,due:0,ivl:0,factor:0,reps:0,lapses:0,left:0,odue:0,odid:0,flags:0,data:''};
  if(!model)return <div class="screen"><Toolbar title="Note type unavailable" nav={{icon:'back',label:'Back',onClick:onBack}} /></div>;
  return <div class="screen"><Toolbar title={noteId?'Edit note':'Add note'} nav={{icon:'back',label:'Back',onClick:()=>dirty?setDiscard(true):onBack()}}><IconButton icon="infoOutline" label="Preview note" onClick={()=>setPreview(true)} /><IconButton icon="restore" label="Save note" disabled={busy} onClick={()=>void save()} /></Toolbar>
    <div class="work-page editor-page"><div class="page-controls"><label>Type<select aria-label="Note type" value={modelId} disabled={!!noteId||busy} onChange={(event)=>{const id=Number(event.currentTarget.value);setModelId(id);setFields(app.col.model(id).flds.map((_:unknown,i:number)=>fields[i]??''));}}>{models.map((model)=><option value={model.id}>{model.name}</option>)}</select></label><label>Deck<select aria-label="Note deck" value={deckId} disabled={busy} onChange={(event)=>setDeckId(Number(event.currentTarget.value))}>{app.col.decksSorted().filter((deck)=>!deck.filtered).map((deck)=><option value={deck.id}>{deck.name}</option>)}</select></label></div>
      <div class="editor-tools" role="toolbar" aria-label="Field formatting"><button type="button" onClick={()=>wrap('<b>','</b>')} aria-label="Bold"><b>B</b></button><button type="button" onClick={()=>wrap('<i>','</i>')} aria-label="Italic"><i>I</i></button><button type="button" onClick={()=>wrap('<u>','</u>')} aria-label="Underline"><u>U</u></button><button type="button" onClick={()=>wrap('<br>','')} aria-label="Line break">↵</button><button type="button" onClick={()=>{const numbers=fields.flatMap((field)=>[...field.matchAll(/\{\{c(\d+)::/g)].map((match)=>Number(match[1])));wrap(`{{c${Math.max(0,...numbers)+1}::`,'}}');}} aria-label="Insert cloze">[…]</button><button type="button" disabled={busy} onClick={()=>{if(mediaInput.current){mediaInput.current.value='';mediaInput.current.click();}}}>Attach</button></div>
      {model.flds.map((field:{name:string;rtl?:boolean},i:number)=><label class="editor-field"><span>{field.name}</span><textarea aria-label={field.name} ref={(element)=>{inputs.current[i]=element;}} value={fields[i]??''} dir={field.rtl?'rtl':'auto'} spellcheck={true} onFocus={()=>setActive(i)} onInput={(event)=>update(i,event.currentTarget.value)} onKeyDown={(event)=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();void save();}}} /></label>)}
      {duplicates.length?<p class="inline-warning" role="status">{duplicates.length} other {duplicates.length===1?'note has':'notes have'} the same first field. You can still save.</p>:null}
      <label class="editor-field"><span>Tags</span><input type="text" aria-label="Tags" value={tags} onInput={(event)=>setTags(event.currentTarget.value)} placeholder="Separate tags with spaces" /></label><p class="muted">Fields support HTML. Use Preview to see the card as it will appear when studying.</p>
      {error?<p class="inline-error" role="alert">{error}</p>:null}{status?<p class="inline-status" role="status">{status}</p>:null}
      <div class="editor-actions"><TextButton label={busy?'Saving…':noteId?'Save changes':'Add'} disabled={busy} onClick={()=>void save()} /><TextButton label="Preview" onClick={()=>setPreview(true)} /></div>
    </div><input class="visually-hidden" type="file" ref={mediaInput} onChange={(event)=>{const file=event.currentTarget.files?.[0];if(file)void attach(file);}} />
    {discard?<Dialog title="Discard changes?" onDismiss={()=>setDiscard(false)}><p>Your unsaved note changes will be discarded.</p><div class="actions"><TextButton label="Keep editing" onClick={()=>setDiscard(false)} /><TextButton label="Discard" onClick={onBack} /></div></Dialog>:null}
    {preview?<CardPreview app={app} content={renderNoteContent(app.col,draftCard,{flds:fields.join('\x1f'),tags},model)} onClose={()=>setPreview(false)} />:null}
  </div>;
}
