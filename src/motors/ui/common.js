// Bits the motor UI parts share.

/** MOTORS A | B | BOTH buttons for the plugin's motors (the row hides with just one).
 *  Motors alternate left / right in channels.json order: A = L, B = R. */
export function useButtons($, id, drives, pick) {
  const opts = drives.length > 1 ? [...drives.map((c, k) => [String(c.i), `${c.name} · ${k % 2 ? 'R' : 'L'}`]),
    ['all', drives.length === 2 ? 'BOTH' : 'ALL']] : [];
  $(id).replaceChildren(...opts.map(([v, label]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.use = v;
    b.addEventListener('click', () => pick(v));
    return b;
  }));
  $(id).style.gridTemplateColumns = `repeat(${opts.length || 1}, minmax(0, 1fr))`;
  $(id).closest('.userow').hidden = !opts.length;
}

/** A motion tile (the ANIMATIONS-style button): name on top, a state line under it. */
export function motionTile(label, onClick) {
  const b = document.createElement('button');
  b.className = 'anim';
  b.innerHTML = '<span class="name"></span><span class="state"></span>';
  b.firstChild.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** A 0..100-style slider that only acts once you stop moving it for `ms`. */
export function slider($, id, unit, ms, act) {
  let t = null;
  $(id).addEventListener('input', () => {
    $(id + 'Out').textContent = `${$(id).value}${unit}`;
    clearTimeout(t);
    t = setTimeout(() => act(Number($(id).value)), ms);
  });
}

/** Show a value on a slider (unless it's being dragged) and its read-out. */
export function showSlider($, id, v, text = `${v}%`) {
  if (document.activeElement !== $(id)) $(id).value = v;
  $(id + 'Out').textContent = text;
}
