// Navegação espacial pelas setas (teclado no Windows, controle remoto na Smart TV / Android TV).

const FOCUSABLE = '[data-focusable], .card, .episode, .btn, .circle-btn, .chip, .row-more, select, .icon-btn, input, .pl-item button';

function visible(elm) {
  const r = elm.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const style = getComputedStyle(elm);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function scope() {
  const modal = document.querySelector('#modal-root .modal-backdrop:last-child');
  return modal || document;
}

function center(r) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function findNext(from, dir) {
  const candidates = [...scope().querySelectorAll(FOCUSABLE)].filter((e) => e !== from && !e.disabled && visible(e));
  const fr = from.getBoundingClientRect();
  const fc = center(fr);
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const r = c.getBoundingClientRect();
    const cc = center(r);
    const dx = cc.x - fc.x;
    const dy = cc.y - fc.y;
    let primary, secondary;
    if (dir === 'ArrowRight') {
      if (r.left < fr.right - 4) continue;
      primary = dx;
      secondary = Math.abs(dy);
    } else if (dir === 'ArrowLeft') {
      if (r.right > fr.left + 4) continue;
      primary = -dx;
      secondary = Math.abs(dy);
    } else if (dir === 'ArrowDown') {
      if (r.top < fr.bottom - 4) continue;
      primary = dy;
      secondary = Math.abs(dx);
    } else {
      if (r.bottom > fr.top + 4) continue;
      primary = -dy;
      secondary = Math.abs(dx);
    }
    const score = primary + secondary * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

export function initSpatialNav(isBlocked) {
  document.addEventListener('keydown', (e) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    if (isBlocked()) return;
    const active = document.activeElement;
    if (active && active.matches('input[type=search], input[type=text], input[type=url], input[type=number]') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    if (active && active.tagName === 'SELECT') return;
    e.preventDefault();
    const from = active && active !== document.body && scope().contains(active) ? active : null;
    if (!from) {
      const first = [...scope().querySelectorAll('.card, .btn, .episode')].find(visible);
      first?.focus();
      return;
    }
    const next = findNext(from, e.key);
    if (next) {
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      if (next.classList.contains('card')) {
        const row = next.closest('.row');
        if (row && e.key.match(/Up|Down/)) {
          const top = row.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.35;
          window.scrollTo({ top, behavior: 'smooth' });
        }
      }
    }
  });
}
