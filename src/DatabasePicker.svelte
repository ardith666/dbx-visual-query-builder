<script>
  // A searchable database picker. A native <select> cannot be filtered, and
  // this connection exposes 60+ databases, so the list needs a needle and full
  // keyboard control.
  let { databases = [], value = "", onpick, disabled = false } = $props();

  let open = $state(false);
  let needle = $state("");
  let active = $state(0);
  let root = $state(null);
  let input = $state(null);
  let id = $derived(`dbpick-${Math.random().toString(36).slice(2, 8)}`);

  const matches = $derived.by(() => {
    const q = needle.trim().toLowerCase();
    const list = q ? databases.filter((d) => d.toLowerCase().includes(q)) : databases;
    // Keep the current selection reachable at the top of an unfiltered list.
    return [...list].sort((a, b) => (a === value ? -1 : b === value ? 1 : a.localeCompare(b)));
  });

  function toggle() {
    if (disabled) return;
    open = !open;
    if (open) {
      needle = "";
      active = 0;
      queueMicrotask(() => input?.focus());
    }
  }

  function choose(name) {
    onpick(name);
    open = false;
  }

  function move(step) {
    if (!open) return;
    const next = active + step;
    if (next < 0) active = 0;
    else if (next >= matches.length) active = Math.max(0, matches.length - 1);
    else active = next;
  }

  function onKeydown(event) {
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); if (!open) toggle(); else move(1); break;
      case "ArrowUp": event.preventDefault(); if (open) move(-1); break;
      case "Enter":
        if (open) { event.preventDefault(); if (matches[active]) choose(matches[active]); }
        else toggle();
        break;
      case "Escape": if (open) { event.preventDefault(); open = false; } break;
      case "Home": if (open) { event.preventDefault(); active = 0; } break;
      case "End": if (open) { event.preventDefault(); active = Math.max(0, matches.length - 1); } break;
      default: break;
    }
  }

  function chooseFromKey(event, name) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(name);
    }
  }

  // Close on an outside click. `contains` rather than stopPropagation on the
  // panel, so only a genuine outside click closes it.
  $effect(() => {
    if (!open) return;
    const onDown = (event) => {
      if (root && !root.contains(event.target)) open = false;
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  });
</script>

<div class="picker" bind:this={root} onkeydown={onKeydown} role="presentation">
  <button
    type="button"
    class="trigger"
    {disabled}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={id}
    onclick={toggle}
  >
    <span class="current" class:empty={!value}>{value || "select a database"}</span>
    <span class="caret" aria-hidden="true">▾</span>
  </button>

  {#if open}
    <div class="panel">
      <input
        bind:this={input}
        bind:value={needle}
        type="search"
        class="needle"
        placeholder="Search databases…"
        aria-label="Search databases"
        aria-controls={id}
        autocomplete="off"
        spellcheck="false"
      />
      <ul id={id} role="listbox" aria-label="Databases">
        {#each matches as name, i (name)}
          <li
            role="option"
            aria-selected={name === value}
            class:current={name === value}
            class:active={i === active}
            onmouseenter={() => (active = i)}
            onkeydown={(e) => chooseFromKey(e, name)}
            onclick={() => choose(name)}
          >
            <span>{name}</span>
            {#if name === value}<span class="tick" aria-hidden="true">✓</span>{/if}
          </li>
        {:else}
          <li class="none" role="option" aria-selected="false" aria-disabled="true">No database matches “{needle}”</li>
        {/each}
      </ul>
      <p class="tally">
        {matches.length === databases.length
          ? `${databases.length} databases`
          : `${matches.length} of ${databases.length}`}
      </p>
    </div>
  {/if}
</div>

<style>
  .picker { position: relative; }
  .trigger {
    display: flex; align-items: center; gap: 6px;
    max-width: 260px; min-width: 160px;
    border: 1px solid var(--color-border, #e4e4e7);
    background: Canvas; color: CanvasText;
    border-radius: 6px; padding: 4px 8px; cursor: pointer; font: inherit;
  }
  .trigger:disabled { opacity: .5; cursor: default; }
  .current { font-family: ui-monospace, monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .current.empty { color: GrayText; font-style: italic; }
  .caret { margin-left: auto; color: GrayText; font-size: 10px; }

  .panel {
    position: absolute; right: 0; top: calc(100% + 4px); z-index: 30;
    width: 300px; max-width: 78vw;
    background: Canvas; color: CanvasText;
    border: 1px solid var(--color-border, #e4e4e7);
    border-radius: 8px; box-shadow: 0 10px 26px rgb(0 0 0 / .22);
    padding: 6px; display: flex; flex-direction: column; gap: 5px;
  }
  .needle {
    width: 100%; box-sizing: border-box; padding: 5px 7px; font: inherit; font-size: 11px;
    background: Canvas; color: CanvasText;
    border: 1px solid var(--color-border, #e4e4e7); border-radius: 5px;
  }
  ul { list-style: none; margin: 0; padding: 0; max-height: 260px; overflow: auto; }
  li {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 6px; border-radius: 4px; cursor: pointer;
    font-family: ui-monospace, monospace; font-size: 11px;
  }
  li.active { background: color-mix(in srgb, LinkText 16%, Canvas); }
  li.current { font-weight: 700; }
  li.none { color: GrayText; font-style: italic; cursor: default; }
  li.none:hover { background: none; }
  .tick { margin-left: auto; color: LinkText; }
  .tally { margin: 0; padding: 2px 4px 0; font-size: 10px; color: GrayText; }
</style>
