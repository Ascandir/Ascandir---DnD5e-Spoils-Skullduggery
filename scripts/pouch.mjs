import { MODULE_ID, pouchNames, inPouch } from "./rules.mjs";

/**
 * Verbrauchsgegenstände in Taschen (z. B. "Pouch", "Backpack") sollen benutzbar sein, ohne sie erst herauszuziehen.
 * Wir ändern dafür nur die berechneten Werte im Speicher: Ein Verbrauchsgegenstand in einer so benannten Tasche
 * zählt für Charakterbogen und Aktionsleisten als lose im Inventar. Gespeichert wird nichts, in der Tasche bleibt er liegen.
 */
export function registerPouch() {
  const model = CONFIG.Item?.dataModels?.consumable;
  const proto = model?.prototype;
  if (!proto || proto._clPouch) return;
  const original = proto.prepareDerivedData;
  proto.prepareDerivedData = function (...args) {
    const out = original?.apply(this, args);
    try {
      const id = this.container;
      if (id) {
        const item = this.parent;
        const bag = item?.actor?.items?.get?.(id);
        const names = pouchNames(game.settings?.get?.(MODULE_ID, "pouchNames"));
        if (bag && inPouch(bag.name, names)) {
          this._clPouchId = id;
          this.container = null;
        }
      }
    } catch {
      /* Einstellung beim Laden noch nicht verfügbar: ignorieren */
    }
    return out;
  };
  proto._clPouch = true;
}

/** Alle Actors neu berechnen und offene Bögen aktualisieren (nach Änderung der Einstellung). */
export function refreshPouch() {
  const actors = new Set(game.actors?.contents ?? []);
  for (const tk of canvas?.tokens?.placeables ?? []) if (tk.actor) actors.add(tk.actor);
  for (const a of actors) {
    a.reset?.();
    for (const app of Object.values(a.apps ?? {})) app.render?.();
  }
  ui.hotbar?.render?.();
}
