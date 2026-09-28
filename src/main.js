import App from "./App.svelte";
import { mount } from "svelte";

// No mock hook here on purpose. A query string cannot reach this iframe (it is
// `about:srcdoc`), so the flag would be dead code that still pulls the mock
// bridge into the shipped bundle. The DOM harness mounts the same App from
// test/mock-entry.js instead, where the fixture is opt-in by construction.
mount(App, { target: document.getElementById("app") });
