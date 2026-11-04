// Budget battery renderer (SPEC §6.4 right rail, §6.5 rules). Numbers appear ONLY from a BatteryModel of
// kind 'numbers', which only exists when budgetOf().coreOk === true on a good tick. Everything else renders
// UNKNOWN with a clock and no digits other than the clock itself.
import * as copy from '../copy';
import { fmtBlock, fmtInt, fmtUtcHHMM, el, clear } from '../format';
import type { BatteryModel } from '../state';

export function renderBattery(container: HTMLElement, m: BatteryModel): void {
  clear(container);
  container.className = 'battery';
  switch (m.kind) {
    case 'no-wallet':
      container.dataset.state = 'no-wallet';
      container.append(el('div', { class: 'battery-line muted', text: copy.REASON_NO_WALLET }));
      return;
    case 'not-joined':
      container.dataset.state = 'not-joined';
      container.append(el('div', { class: 'battery-line muted', text: copy.REASON_NOT_JOINED }));
      return;
    case 'unknown':
      container.dataset.state = 'unknown';
      container.append(
        el('div', { class: 'battery-line label-unknown' }, el('span', { class: 'tag tag-unknown', text: copy.LABEL_UNKNOWN }), ' ', el('span', { class: 'battery-unknown', text: copy.BATTERY_UNKNOWN(fmtUtcHHMM(m.asOfMs)) })),
        el('div', { class: 'battery-foot muted', text: copy.WORD_UNKNOWN(fmtUtcHHMM(m.asOfMs)) }),
      ); // no meter here: a 0..40 track would read as "0", and numbers are unknown, not zero
      return;
    case 'numbers': {
      container.dataset.state = 'numbers';
      const tagClass = m.label === 'SETTLED' ? 'tag tag-settled' : 'tag tag-fresh';
      const arrivedLine = el('div', { class: 'battery-line' }, copy.BATTERY_ARRIVED(fmtInt(m.arrived), fmtInt(m.forfeited)));
      if (m.forfeited > 0n) arrivedLine.append(' ', el('span', { class: 'tag tag-forfeited', text: copy.LABEL_FORFEITED })); // §6.5 FORFEITED label
      // decorative meter: width is the measured READY of this tick (0..40); no text, no time-based motion
      const meter = el('div', { class: 'battery-meter', 'aria-hidden': 'true' });
      meter.style.setProperty('--ready', String(Math.max(0, Math.min(40, Number(m.ready)))));
      container.append(el('div', { class: 'battery-line battery-ready', text: copy.BATTERY_READY(String(m.ready), String(m.banked), String(m.fresh)) }), meter, arrivedLine);
      if (m.pending !== null && m.pending > 0) {
        container.append(el('div', { class: 'battery-line label-pending' }, el('span', { class: 'tag tag-pending', text: copy.LABEL_PENDING }), ' ', copy.BATTERY_PENDING(String(m.pending))));
      }
      container.append(
        el('div', { class: 'battery-line' }, `Squeek block ${fmtInt(m.coreHeight)} · `, el('span', { class: tagClass, text: m.label })),
        el('div', { class: 'battery-foot muted', text: copy.BUDGET_FOOTNOTE(fmtBlock(m.ethBlock), m.label) }),
      );
      return;
    }
  }
}
