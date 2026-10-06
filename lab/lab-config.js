// ============================================================================
// lab/lab-config.js · The Filter AI · the Lab's one settings file
// ----------------------------------------------------------------------------
// Rename the Lab here. Change a model here. Nothing else needs editing:
//   - the game reads this file in the browser (it ships in BOTH builds, so
//     the free site can show the locked teaser with the right name)
//   - tools/kit.js reads it at build time and writes the starter kit's
//     config.py and the n8n workflow files from it
//
// Model names are Ollama tags. They were checked against ollama.com/library
// and docs.ollama.com in October 2026 (qwen3 is the model the Ollama tool
// calling docs use). If a tag is retired, change it here and rebuild.
//
// House style: no em dashes anywhere in player-facing strings.
// ============================================================================

const LAB_CONFIG = {
  name: "Build & Break Lab",
  story: "You've been the filter. Now build the thing the filter protects, break it yourself, then defend it.",

  models: {
    starter: "qwen3:4b",      // first chat in Stage 1, about 2.5 GB to download
    agent: "qwen3:4b",        // the Notes Assistant. Tool calling capable.
    agentBigger: "qwen3:8b",  // the upgrade if you have 16 GB or more, about 5.2 GB
    judge: "qwen3:1.7b",      // the small judge model in Stage 4, about 1.4 GB
    lmStudioSearch: "Qwen3 4B" // what to type in LM Studio's Discover search
  },

  // Example tags the hardware calculator shows next to each size class.
  // Sizes are billions of parameters. null means "no example tag".
  sizeExamples: [
    { params: 1.7, tag: "qwen3:1.7b", use: "fast helper, judge, autocomplete" },
    { params: 4,   tag: "qwen3:4b",   use: "everyday chat, small agents" },
    { params: 8,   tag: "qwen3:8b",   use: "better reasoning, steadier tools" },
    { params: 14,  tag: "qwen3:14b",  use: "strong all-rounder" },
    { params: 32,  tag: "qwen3:32b",  use: "near the top of home hardware" },
    { params: 70,  tag: null,         use: "workstation class" }
  ],

  // The two ways to build the same agent. Learners pick one and can switch.
  paths: {
    code:   { label: "Code (Python + Ollama)" },
    nocode: { label: "No-code (n8n)" }
  },

  ollamaUrl: "http://localhost:11434",
  ollamaFromDocker: "http://host.docker.internal:11434",
  n8nUrl: "http://localhost:5678",
  notesPort: 8765,

  // A fake secret planted in the agent's system prompt, so learners can test
  // whether their rulebook leaks.
  canary: "NA-REF-7731-FAKE",

  kitFile: "build-break-starter-kit.zip",
  kitFolder: "build-break-starter-kit",

  // Public teaser shown on the locked Lab screen (free site and no key).
  teaser: {
    laptop: "You only need a laptop. Everything runs on your own machine with fake data, and every step says what to do next, so it works if this is your first time. It is the same method enterprise security teams use to test AI systems in an isolated test lab. Only test systems you own or have written permission to test.",
    outcomes: ["Run and size local AI models", "Build a tool-using agent, in code or no-code", "Test an AI app for prompt injection", "Add defences and measure them honestly", "Write a short red team findings report"],
    stages: [
      { title: "Run it.",    blurb: "Run an open-weights model on your own laptop. A calculator tells you what your machine can handle before you download anything." },
      { title: "Build it.",  blurb: "Build a small agent that lists, reads and adds up your notes. In plain Python, or with no code at all in n8n." },
      { title: "Break it.",  blurb: "Plant four attacks in its notes and watch your own agent fall for them, one by one." },
      { title: "Filter it.", blurb: "Add five layers of defence, re-run every attack, and keep an honest scorecard." }
    ],
    includes: ["Local model setup", "Code or no-code path", "Hardware calculator", "Starter kit download",
               "Attack replays", "Defence scorecard", "Capstone red team", "Completion badge"]
  }
};

if (typeof module !== "undefined") module.exports = { LAB_CONFIG };
