import { MODULE_ID, pouchNames, inPouch } from "./rules.mjs";

/**
 * Verbrauchsgegenstände in Taschen (z. B. "Pouch", "Backpack") sollen im Inventar des Charakterbogens
 * auftauchen und sich dort benutzen lassen, ohne sie aus der Tasche zu nehmen. Sie bleiben in der Tasche
 * und stehen dort weiter drin. Wir hängen sie nur zusätzlich in die Inventarliste des Bogens ein.
 * Gespeichert oder verschoben wird nichts.
 */
export function registerPouch() {
  const sheetClass = globalThis.dnd5e?.applications?.actor?.CharacterActorSheet;
  if (!sheetClass) return;
  let proto = sheetClass.prototype;
  while (proto && !Object.hasOwn(proto, "_prepareItems")) proto = Object.getPrototypeOf(proto);
  if (!proto || proto._clPouch) return;
  const original = proto._prepareItems;
  proto._prepareItems = async function (context, ...rest) {
    const out = await original.call(this, context, ...rest);
    try {
      await addPouchItems(this, context);
    } catch (err) {
      console.warn(`${MODULE_ID} | Taschen-Inhalt im Bogen`, err);
    }
    return out;
  };
  proto._clPouch = true;
}

async function addPouchItems(sheet, context) {
  const names = pouchNames(game.settings.get(MODULE_ID, "pouchNames"));
  if (!names.length) return;
  const actor = sheet.actor;
  const bags = new Set(actor.items.filter((i) => i.type === "container" && inPouch(i.name, names)).map((i) => i.id));
  if (!bags.size) return;
  const extra = actor.items.filter((i) => i.type === "consumable" && bags.has(i.system.container) && sheet._isItemVisible(i));
  for (const item of extra) {
    if (context.itemContext[item.id]) continue;
    const ctx = (context.itemContext[item.id] ??= {});
    ctx.clickAction = "use";
    sheet._prepareItem(item, ctx);
    await sheet._prepareItemPhysical(item, ctx);
    ctx.isExpanded = sheet.expandedSections.get(`items.${item.id}`) === true;
    if (ctx.isExpanded) ctx.expanded = await item.getChatData({ secrets: item.isOwner });
    for (const category of sheet._assignItemCategories(item) ?? []) {
      context.itemCategories[category] ??= [];
      context.itemCategories[category].push(item);
    }
    ctx.dataset = Object.fromEntries(Object.entries(ctx.groups ?? {}).map(([k, v]) => [`group-${k}`, v]));
    context.items.push(item);
  }
}

/** Offene Bögen neu zeichnen (nach Änderung der Einstellung). */
export function refreshPouch() {
  for (const app of foundry.applications.instances.values()) {
    if (app.actor && app.constructor.name.includes("ActorSheet")) app.render();
  }
}
