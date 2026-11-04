// Footer (SPEC §7.1, every route). The text is static HTML in index.html so `curl` sees it without JS;
// this module only guarantees it is present and exactly equal to the pinned copy.
import { FOOTER } from '../copy';

export function mountFooter(): HTMLElement {
  let f = document.getElementById('footer');
  if (!f) {
    f = document.createElement('footer');
    f.id = 'footer';
    f.className = 'footer';
    document.body.appendChild(f);
  }
  if (f.textContent?.trim() !== FOOTER) f.textContent = FOOTER;
  return f;
}
