// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from 'preact/hooks';
import type { AppController } from '../app/controller';
import { TextButton } from '../app/ui';

export function PwaNotices({ app }: { app: AppController }) {
  const [update, setUpdate] = useState<ServiceWorkerRegistration | null>(null);
  const [hint, setHint] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = (navigator as Navigator & { standalone?: boolean }).standalone || matchMedia('(display-mode: standalone)').matches;
    setHint(ios && !standalone && !app.meta.installHintDismissed);
    if (!import.meta.env.PROD || !isSecureContext || !('serviceWorker' in navigator)) return;
    let disposed = false;
    let registration: ServiceWorkerRegistration | undefined;
    const found = () => {
      if (!disposed && registration?.waiting && navigator.serviceWorker.controller) setUpdate(registration);
    };
    void navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './', updateViaCache: 'none' }).then((reg) => {
      registration = reg;
      found();
      reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', found));
    }).catch(() => { if (!disposed) setError('Offline setup failed. Reconnect and reload to try again.'); });
    return () => { disposed = true; };
  }, []);
  const dismiss = async () => {
    setHint(false);
    app.meta.installHintDismissed = true;
    await app.store.setMeta({ installHintDismissed: true }).catch(() => {});
  };
  if (update) return <div class="banner" role="status"><p>A Flashi update is ready.</p><TextButton label={applying ? 'Saving…' : 'Update'} disabled={applying} onClick={() => {
    setApplying(true);
    void app.saveNow().then(() => {
      if (app.saveError) { setError('Export a backup before updating: your latest changes could not be saved.'); setApplying(false); return; }
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
      update.waiting?.postMessage('SKIP_WAITING');
    });
  }} />{error ? <p>{error}</p> : null}</div>;
  if (error) return <div class="banner warn" role="status"><p>{error}</p></div>;
  if (!hint) return null;
  return <div class="banner" role="status"><p>To study offline and help keep your data safe, open Safari’s Share menu and choose <strong>Add to Home Screen</strong>.</p><TextButton label="Got it" onClick={() => void dismiss()} /></div>;
}
