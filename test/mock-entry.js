// Test-only entry. Installs the fake host bridge, then mounts the real App so
// the harness drives production code, not a copy of it.
import { mount } from "svelte";
import App from "../src/App.svelte";
import { installMockBridge } from "../src/mock.js";

installMockBridge();
mount(App, { target: document.getElementById("app") });
