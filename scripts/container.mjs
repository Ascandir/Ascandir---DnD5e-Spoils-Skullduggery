import * as Service from "./service.mjs";
import { MODULE_ID, CONTAINER_TYPE, COINS, isLootableItem, buildItemView, stackKey, mergeStacks } from "./rules.mjs";

const t = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));

/** Daten des Container-Actors: Beschreibung und Münzen (gleiche Pfade wie bei dnd5e, damit das Plündern sie lesen kann). */
class ContainerData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const f = foundry.data.fields;
    const coin = () => new f.NumberField({ required: true, nullable: false, integer: true, min: 0, initial: 0 });
    return {
      style: new f.StringField({ required: true, blank: false, choices: ["chest", "sack", "resource"], initial: "chest" }),
      description: new f.HTMLField({ required: false, blank: true }),
      currency: new f.SchemaField(Object.fromEntries(COINS.map((k) => [k, coin()])))
    };
  }
}

/** Wird beim Start (init) aufgerufen: Typ, Datenmodell, Beschriftung und Bogen anmelden. */
export function registerContainer() {
  CONFIG.Actor.dataModels[CONTAINER_TYPE] = ContainerData;
  CONFIG.Actor.typeLabels = { ...(CONFIG.Actor.typeLabels ?? {}), [CONTAINER_TYPE]: "CLOOT.Container.Type" };
  CONFIG.Actor.typeIcons = { ...(CONFIG.Actor.typeIcons ?? {}), [CONTAINER_TYPE]: "fa-solid fa-box-archive" };

  const sheets = foundry.applications.sheets;
  const Sheet = makeSheet(sheets.ActorSheetV2, foundry.applications.api.HandlebarsApplicationMixin);
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, MODULE_ID, Sheet, {
    types: [CONTAINER_TYPE],
    makeDefault: true,
    label: "CLOOT.Container.Sheet"
  });

  // Neue Container: Truhen-Bild, Token ist nicht mit dem Actor verknüpft (jeder Token würfelt eigene Beute)
  Hooks.on("preCreateActor", (actor) => {
    if (actor.type !== CONTAINER_TYPE) return;
    const img = "icons/containers/chest/chest-wooden-brown.webp";
    actor.updateSource({
      ownership: { ...(actor.ownership ?? {}), default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
      img: actor.img && !actor.img.includes("mystery-man") ? actor.img : img,
      prototypeToken: { actorLink: false, disposition: 0, displayName: 30, texture: { src: img }, flags: { [MODULE_ID]: { box: true, boxLocked: false } } }
    });
  });
}

function makeSheet(ActorSheetV2, HandlebarsApplicationMixin) {
  return class ContainerSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
    static DEFAULT_OPTIONS = {
      classes: ["corpse-loot", "cl-dialog", "cl-container"],
      position: { width: 560, height: 640 },
      window: { icon: "fa-solid fa-box-archive", resizable: true },
      form: { submitOnChange: true, closeOnSubmit: false },
      actions: {
        editImage: ContainerSheet.onEditImage,
        removeItem: ContainerSheet.onRemoveItem,
        editTable: ContainerSheet.onEditTable,
        editLock: ContainerSheet.onEditLock,
        mergeStacks: ContainerSheet.onMergeStacks,
        playersOwn: ContainerSheet.onPlayersOwn
      }
    };

    static PARTS = {
      body: { template: `modules/${MODULE_ID}/templates/container.hbs` }
    };

    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      const actor = this.document;
      const items = actor.items.filter((i) => isLootableItem(i, { nested: true })).map((i) => buildItemView(i, { isGM: true }));
      return {
        ...context,
        actor,
        isGM: game.user.isGM,
        editable: this.isEditable,
        system: actor.system,
        coins: COINS.map((k) => ({ key: k, value: actor.system.currency?.[k] ?? 0, label: t(`CLOOT.Cfg.Coin.${k}`) })),
        items,
        hasItems: items.length > 0,
        styles: [
          { value: "chest", label: t("CLOOT.Container.StyleChest"), selected: (actor.system.style ?? "chest") === "chest" },
          { value: "sack", label: t("CLOOT.Container.StyleSack"), selected: actor.system.style === "sack" },
          { value: "resource", label: t("CLOOT.Container.StyleResource"), selected: actor.system.style === "resource" }
        ],
        playersOwn: this.playersOwn,
        hasTable: Boolean(actor.getFlag(MODULE_ID, "table"))
      };
    }

    /** Dürfen Spieler den Container selbst befüllen? (Besitzerrecht für alle) */
    get playersOwn() {
      const base = this.document.isToken ? this.document.baseActor : this.document;
      return (base?.ownership?.default ?? 0) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    }

    static async onPlayersOwn() {
      const base = this.document.isToken ? this.document.baseActor : this.document;
      const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;
      await base.update({ "ownership.default": this.playersOwn ? L.NONE : L.OWNER });
      this.render();
    }

    static async onEditImage() {
      const Picker = foundry.applications.apps.FilePicker.implementation;
      new Picker({ type: "image", current: this.document.img, callback: (path) => this.document.update({ img: path }) }).render({ force: true });
    }

    static async onRemoveItem(event, target) {
      await this.document.items.get(target.dataset.itemId)?.delete();
    }

    static async onMergeStacks() {
      const n = await mergeStacks(this.document);
      ui.notifications.info(t(n ? "CLOOT.Container.Merged" : "CLOOT.Container.NothingToMerge", { n }));
    }

    async _onRender(context, options) {
      await super._onRender(context, options);
      const root = this.element;
      // Eigener Drop: Gegenstände aus dem Inventar eines Spielers wandern in den Container (und verschwinden dort)
      if (!root._clDrop) {
        root._clDrop = true;
        root.addEventListener("dragover", (ev) => ev.preventDefault(), true);
        root.addEventListener(
          "drop",
          (ev) => {
            const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(ev);
            if (data?.type !== "Item") return; // Münzen, Beschreibung usw. laufen weiter wie gewohnt
            ev.preventDefault();
            ev.stopImmediatePropagation();
            this.dropItem(data).catch((err) => {
              console.error(`${MODULE_ID} |`, err);
              ui.notifications.error(t("CLOOT.Err.Crash", { msg: err?.message ?? String(err) }));
            });
          },
          true
        );
      }
    }

    /** Einen gezogenen Gegenstand ablegen: aus einem Inventar verschieben, aus der Gegenstandsliste kopieren. */
    async dropItem(data) {
      const actor = this.document;
      const item = await Item.implementation.fromDropData(data);
      if (!item || item.parent === actor) return;
      // Aus der Gegenstandsliste oder einem Kompendium: nur die Spielleitung, als Kopie (gestapelt)
      if (!item.parent) {
        if (!game.user.isGM) return;
        const key = stackKey(item);
        const target = key ? actor.items.find((i) => stackKey(i) === key) : null;
        if (target) {
          await target.update({ "system.quantity": (Number(target.system.quantity) || 0) + (Number(item.system.quantity) || 1) });
          return;
        }
        const copy = item.toObject();
        delete copy._id;
        copy.system.container = null;
        await actor.createEmbeddedDocuments("Item", [copy]);
        return;
      }
      // Aus dem Inventar eines Actors: verschieben (bei Stapeln wird nach der Menge gefragt)
      const max = item.type === "container" ? 1 : Number(item.system?.quantity ?? 1) || 1;
      let qty = max;
      if (max > 1) {
        const field = `<div class="form-group"><label>${t("CLOOT.Container.HowMany")}</label><div class="form-fields"><input type="number" name="qty" min="1" max="${max}" step="1" value="${max}" autofocus></div></div>`;
        const res = await foundry.applications.api.DialogV2.prompt({
          window: { title: item.name },
          content: field,
          ok: { label: t("CLOOT.Container.Deposit"), callback: (ev, button) => Number(button.form.elements.qty.value) }
        }).catch(() => null);
        if (!res) return;
        qty = Math.min(max, Math.max(1, Math.floor(res)));
      }
      // Mit Besitzerrecht an beiden Seiten geht es sofort, ganz ohne Spielleiter. Sonst macht es die Spielleitung.
      if (actor.isOwner && item.parent.isOwner) {
        await Service.moveItemTo(item, actor, qty);
        return;
      }
      const res = await Service.request("deposit", { itemUuid: item.uuid, actorUuid: actor.uuid, qty });
      if (!res.ok) ui.notifications.warn(Service.errorText(res));
    }

    static async onEditTable() {
      await game.modules.get(MODULE_ID).api.editTable(this.document);
    }

    static async onEditLock() {
      const token = this.document.isToken ? this.document.token : null;
      await game.modules.get(MODULE_ID).api.editLock({ token, actor: this.document.isToken ? this.document.baseActor : this.document });
    }
  };
}
