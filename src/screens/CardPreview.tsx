// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AppController } from '../app/controller';
import { Dialog, TextButton } from '../app/ui';
import { renderCardContent, type CardContent } from '../anki/template/render';
import { buildCardDocument } from '../app/cardFrame';
import { AudioPlayer } from '../app/audio';
export function CardPreview({ app, cardId, onClose, content: draft }: { app: AppController; cardId?: number; onClose: () => void; content?: CardContent }) {
  const [answer, setAnswer] = useState(false); const [doc, setDoc] = useState('');
  const ref = useRef<HTMLIFrameElement>(null);
  const audio = useMemo(() => new AudioPlayer(app.store.media), []);
  const content = useMemo(() => draft ?? (cardId && app.col.getCard(cardId) ? renderCardContent(app.col, app.col.getCard(cardId)!) : null), [cardId, draft, app.version]);
  useEffect(() => {
    let cancelled = false;
    if (content) void buildCardDocument({ body: answer ? content.answer : content.question, css:content.css,ord:content.ord,side:answer?'a':'q',media:app.store.media,bodyClass:document.documentElement.dataset.colorMode==='dark'?'nightMode night_mode':'' }).then((html) => { if (!cancelled) setDoc(html); });
    return () => { cancelled = true; audio.stop(); };
  },[content,answer]);
  useEffect(() => {
    const listener=(event:MessageEvent)=>{if(event.source!==ref.current?.contentWindow||event.data?.flashi!==1||event.data.type!=='play'||!content)return;const tags=event.data.side==='a'?content.answerAv:content.questionAv;const tag=tags[event.data.index];if(tag)void audio.play([tag]);};
    window.addEventListener('message',listener);return()=>window.removeEventListener('message',listener);
  },[content]);
  return <Dialog title="Preview" onDismiss={onClose}><iframe class="preview-frame" title={answer?'Preview answer':'Preview question'} sandbox="allow-scripts" ref={ref} srcDoc={doc} /><div class="actions"><TextButton label={answer?'Question':'Show answer'} onClick={()=>setAnswer(!answer)} /><TextButton label="Close" onClick={onClose} /></div></Dialog>;
}
