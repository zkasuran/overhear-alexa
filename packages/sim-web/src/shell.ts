// The static chrome around the device: a sticky header with the product name, a category menu whose
// submenus open on hover, focus and tap, and the theme toggle; a product-first hero; the side panel
// with connection, run mode and an honest "what is real" note; and the about sections. It builds DOM
// and returns the handful of references the controller updates. No markup strings, so the CSP stays
// strict.

import { el } from "./dom.js";

export type Shell = {
  themeButton: HTMLButtonElement;
  deviceRoot: HTMLElement;
  controlsRoot: HTMLElement;
  connectionEl: HTMLElement;
  noticeEl: HTMLElement;
};

type MenuItem = { label: string; target: string };

function menu(label: string, items: readonly MenuItem[]): HTMLElement {
  const trigger = el("button", {
    className: "nav-trigger",
    text: label,
    attrs: { type: "button", "aria-haspopup": "true", "aria-expanded": "false" },
  });
  const list = el(
    "div",
    { className: "nav-menu", attrs: { role: "menu" } },
    items.map((it) =>
      el("a", {
        className: "nav-item",
        text: it.label,
        attrs: { role: "menuitem", href: it.target },
      }),
    ),
  );
  const wrap = el("div", { className: "nav-group" }, [trigger, list]);
  const setOpen = (open: boolean): void => {
    wrap.classList.toggle("open", open);
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
  };
  wrap.addEventListener("mouseenter", () => setOpen(true));
  wrap.addEventListener("mouseleave", () => setOpen(false));
  wrap.addEventListener("focusin", () => setOpen(true));
  wrap.addEventListener("focusout", () => setOpen(false));
  trigger.addEventListener("click", () =>
    setOpen(trigger.getAttribute("aria-expanded") !== "true"),
  );
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });
  for (const link of Array.from(list.querySelectorAll("a"))) {
    link.addEventListener("click", () => setOpen(false));
  }
  return wrap;
}

function aboutSection(): HTMLElement {
  const steps = [
    "Type any topic, paste a link or some text, then plan: the server returns an outline in one call.",
    "Play renders the episode; parts stream back and play back to back with no gap.",
    "Pause, skip and time left resolve on the host with no model; a question or go deeper calls a tool.",
  ];
  const real = [
    "Live mode voices every line with Amazon Polly. The default mock mode plays a labelled recorded sample.",
    "Requests are typed or tapped here. On a real Echo, the Overhear Studio skill takes them by voice.",
    "Planning, rendering, questions and navigation all run against the live server over MCP.",
  ];
  const commands = "plan, play, pause, resume, skip, back, go-deeper, ask, time-left, utterance";
  const events =
    "status, ring, outline, part-status, part-ready, caption, ducking, answer, moment, time-left, notice, render-done";
  return el("section", { className: "about", attrs: { id: "about" } }, [
    el("div", { className: "about-col" }, [
      el("h3", { text: "How it works" }),
      el(
        "ol",
        {},
        steps.map((s) => el("li", { text: s })),
      ),
    ]),
    el("div", { className: "about-col" }, [
      el("h3", { text: "What is real and what is simulated" }),
      el(
        "ul",
        {},
        real.map((s) => el("li", { text: s })),
      ),
    ]),
    el("div", { className: "about-col" }, [
      el("h3", { text: "Control protocol" }),
      el("p", { className: "proto", text: `Up: ${commands}.` }),
      el("p", { className: "proto", text: `Down: ${events}.` }),
    ]),
  ]);
}

export function buildShell(root: HTMLElement): Shell {
  const themeButton = el("button", {
    className: "theme-toggle",
    text: "Theme",
    attrs: { type: "button", "aria-pressed": "false" },
  });
  const nav = el("nav", { className: "nav", attrs: { "aria-label": "Sections" } }, [
    menu("Controls", [
      { label: "Plan an episode", target: "#controls" },
      { label: "Transport", target: "#controls" },
      { label: "Push to talk", target: "#controls" },
      { label: "Sample utterances", target: "#controls" },
    ]),
    menu("About", [
      { label: "How it works", target: "#about" },
      { label: "What is real", target: "#about" },
      { label: "Control protocol", target: "#about" },
    ]),
    themeButton,
  ]);
  const header = el("header", { className: "site-header" }, [
    el("div", { className: "brand" }, [
      el("span", { className: "logo", attrs: { "aria-hidden": "true" } }),
      el("span", { className: "brand-name", text: "Alexa+ simulator" }),
    ]),
    nav,
  ]);

  const hero = el("section", { className: "hero" }, [
    el("h1", { className: "hero-title", text: "Steer a two-host audio episode by voice." }),
    el("p", {
      className: "hero-sub",
      text: "Plan an outline, play it, then go deeper, ask a question or skip around while it plays. This device view drives the live server through the simulator host.",
    }),
  ]);

  const deviceRoot = el("div", { className: "device-root", attrs: { id: "device" } });

  const connectionEl = el("span", { className: "conn", text: "connecting" });
  const noticeEl = el("div", {
    className: "notice",
    attrs: { "aria-live": "assertive", role: "status" },
  });
  const side = el("aside", { className: "side" }, [
    el("div", { className: "side-card" }, [
      el("h3", { text: "Connection" }),
      el("div", { className: "conn-row" }, [el("span", { text: "Host link" }), connectionEl]),
      noticeEl,
    ]),
  ]);

  const stage = el("div", { className: "stage" }, [deviceRoot, side]);
  const controlsRoot = el("section", { className: "controls-root", attrs: { id: "controls" } });

  const main = el("main", { className: "wrap" }, [hero, stage, controlsRoot, aboutSection()]);
  const footer = el("footer", { className: "site-footer" }, [
    el("span", { text: "Alexa+ simulator. The badge shows live or mock." }),
  ]);

  root.appendChild(header);
  root.appendChild(main);
  root.appendChild(footer);
  return { themeButton, deviceRoot, controlsRoot, connectionEl, noticeEl };
}
