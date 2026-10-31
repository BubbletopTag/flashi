// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ICONS, type IconName } from "../theme/icons";

export function Icon({ name, title, color }: { name: IconName; title?: string; color?: string }) {
  const icon = ICONS[name];
  return (
    <svg class="icon" viewBox={icon.viewBox} aria-hidden={title ? undefined : "true"} role={title ? "img" : undefined} style={color ? { fill: color } : undefined}>
      {title ? <title>{title}</title> : null}
      {icon.paths.map((d) => (
        <path d={d} />
      ))}
    </svg>
  );
}

/** Flashi's own mark: a light-green card with a lightning flash (not Anki's star). */
export function FlashiLogo({ size = 48 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <rect x="9" y="5" width="30" height="38" rx="6" fill="#8BC34A" />
      <rect x="9" y="5" width="30" height="38" rx="6" fill="none" stroke="#33691E" stroke-width="2" />
      <path d="M27 10 L17 26 H23.5 L20.5 38 L31 21.5 H24.5 Z" fill="#FFFFFF" stroke="#33691E" stroke-width="1.5" stroke-linejoin="round" />
    </svg>
  );
}

/** Material-style touch ripple, attached with onPointerDown={ripple}. */
export function ripple(e: PointerEvent): void {
  const el = e.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  const d = Math.max(rect.width, rect.height) * 2;
  el.style.setProperty("--rx", `${e.clientX - rect.left}px`);
  el.style.setProperty("--ry", `${e.clientY - rect.top}px`);
  el.style.setProperty("--rd", `${d}px`);
  el.classList.remove("rippling");
  void el.offsetWidth;
  el.classList.add("rippling");
}

export function IconButton(props: {
  icon: IconName;
  label: string;
  onClick: (e: MouseEvent) => void;
  disabled?: boolean;
  color?: string;
  id?: string;
}) {
  return (
    <button
      id={props.id}
      class="icon-btn ripple"
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onPointerDown={ripple}
      onClick={(e) => props.onClick(e)}
    >
      <Icon name={props.icon} color={props.color} />
    </button>
  );
}

export function Toolbar(props: {
  title?: string;
  subtitle?: string;
  nav?: { icon: IconName; label: string; onClick: () => void };
  children?: ComponentChildren;
}) {
  return (
    <header class="toolbar">
      {props.nav ? <IconButton icon={props.nav.icon} label={props.nav.label} onClick={props.nav.onClick} /> : null}
      <div class={`titles${props.nav ? "" : " no-nav"}`}>
        {props.title ? <div class="title">{props.title}</div> : null}
        {props.subtitle ? <div class="subtitle">{props.subtitle}</div> : null}
      </div>
      {props.children}
    </header>
  );
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  iconColor?: string;
  onSelect: () => void;
  disabled?: boolean;
}

/** A popup menu anchored to the top-right of `anchor`, like Android's overflow menu. */
export function PopupMenu(props: { anchor: HTMLElement; items: MenuItem[]; onClose: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  useLayoutEffect(() => {
    const r = props.anchor.getBoundingClientRect();
    setPos({ top: Math.max(r.top + 4, 4), right: Math.max(window.innerWidth - r.right + 4, 4) });
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [props.anchor]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <div class="menu-backdrop" onClick={props.onClose} />
      <div class="menu" role="menu" aria-label={props.label} ref={ref} style={{ top: `${pos.top}px`, right: `${pos.right}px` }}>
        {props.items.map((item) => (
          <button
            type="button"
            role="menuitem"
            class="menu-item ripple"
            disabled={item.disabled}
            onPointerDown={ripple}
            onClick={() => {
              props.onClose();
              item.onSelect();
            }}
          >
            {item.icon ? <Icon name={item.icon} color={item.iconColor} /> : null}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}

export function Dialog(props: { title: string; children: ComponentChildren; onDismiss?: () => void; labelledBy?: string }) {
  const id = props.labelledBy ?? "dialog-title";
  useEffect(() => {
    if (!props.onDismiss) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onDismiss?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onDismiss]);
  return (
    <div class="dialog-scrim" onClick={(e) => e.target === e.currentTarget && props.onDismiss?.()}>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby={id}>
        <h2 id={id}>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

export function TextButton(props: { label: string; onClick: () => void; disabled?: boolean; id?: string }) {
  return (
    <button id={props.id} type="button" class="text-btn ripple" disabled={props.disabled} onPointerDown={ripple} onClick={props.onClick}>
      {props.label}
    </button>
  );
}

export interface SnackbarMessage {
  text: string;
  action?: { label: string; onClick: () => void };
  /** Bumped to re-show the same text. */
  key: number;
}

export function Snackbar({ message, onDone }: { message: SnackbarMessage | null; onDone: () => void }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, message.action ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [message?.key]);
  if (!message) return null;
  return (
    <div class="snackbar" role="status" aria-live="polite">
      <p>{message.text}</p>
      {message.action ? (
        <TextButton
          label={message.action.label}
          onClick={() => {
            message.action!.onClick();
            onDone();
          }}
        />
      ) : null}
    </div>
  );
}

export function Switch({ on }: { on: boolean }) {
  return <span class={`switch${on ? " on" : ""}`} aria-hidden="true" />;
}
