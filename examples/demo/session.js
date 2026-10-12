window.__GRILL__ = {
  "version": 1,
  "lang": "en",
  "title": "Recipe box",
  "idea": "A small app where a family keeps and shares its recipes.",
  "status": "active",
  "answered": "",
  "architecture": [
    "A web app that also works on a phone browser.",
    "One SQLite file holds recipes and members.",
    "Photos are saved as files beside the database."
  ],
  "sketches": [
    { "id": "k1", "title": "Home", "src": "sketch/home.html", "rev": 1, "width": 390, "height": 760, "note": "Photos follow the decision on Q3." }
  ],
  "refs": [
    { "id": "r1", "src": "refs/home-list.svg", "target": "q8:a", "caption": "" },
    { "id": "r2", "src": "refs/home-grid.svg", "target": "q8:b", "caption": "" },
    { "id": "r3", "src": "refs/home-hero.svg", "target": "q8:c", "caption": "" },
    { "id": "r4", "src": "refs/recipe-card.svg", "target": "q3", "caption": "How a recipe with several photos could look." }
  ],
  "research": [
    {
      "id": "s1",
      "target": "q2",
      "topic": "How does SQLite run behind a small web app?",
      "status": "done",
      "finding": "SQLite is a library, not a server: the web app opens the file directly.\nIt handles a family's traffic easily; turn on WAL mode so reads do not wait for writes.",
      "report": "research/s1.md",
      "sources": [
        { "title": "SQLite: appropriate uses", "url": "https://sqlite.org/whentouse.html" },
        { "title": "", "url": "https://sqlite.org/wal.html" }
      ]
    },
    {
      "id": "s2",
      "target": "q3",
      "topic": "How should photos be resized on upload?",
      "status": "running",
      "finding": "",
      "sources": []
    },
    {
      "id": "s3",
      "target": "q1",
      "topic": "What makes a web app installable on a phone?",
      "status": "todo",
      "finding": "",
      "sources": []
    },
    {
      "id": "s4",
      "target": "",
      "topic": "Which recipe apps do families already use?",
      "status": "todo",
      "finding": "",
      "sources": []
    }
  ],
  "questions": [
    {
      "id": "q1",
      "round": 1,
      "title": "Where does the app run?",
      "body": "This decides how the family reaches it and how much setup it needs.",
      "dependsOn": [],
      "status": "settled",
      "options": [
        { "id": "a", "label": "Native phone app" },
        { "id": "b", "label": "Web app" },
        { "id": "c", "label": "Desktop app" }
      ],
      "recommended": "b",
      "recommendation": "",
      "answer": { "option": "b", "text": "" },
      "decision": "The app is a web app that also works on a phone browser."
    },
    {
      "id": "q2",
      "round": 1,
      "title": "Where do recipes live?",
      "body": "",
      "dependsOn": [],
      "status": "settled",
      "options": [
        { "id": "a", "label": "Plain files" },
        { "id": "b", "label": "SQLite" },
        { "id": "c", "label": "Hosted database" }
      ],
      "recommended": "b",
      "recommendation": "",
      "answer": { "option": "b", "text": "Keep it to one file we can back up." },
      "decision": "Recipes and members are stored in one SQLite file."
    },
    {
      "id": "q3",
      "round": 1,
      "title": "What about photos?",
      "body": "",
      "dependsOn": [],
      "status": "settled",
      "options": [
        { "id": "a", "label": "No photos" },
        { "id": "b", "label": "One photo per recipe" }
      ],
      "recommended": "a",
      "recommendation": "",
      "answer": { "option": null, "text": "Several photos per recipe, grandma's handwritten cards matter." },
      "decision": "A recipe can carry several photos, saved as files beside the database."
    },
    {
      "id": "q4",
      "round": 2,
      "title": "How do members sign in?",
      "body": "",
      "dependsOn": ["q1"],
      "status": "asking",
      "options": [],
      "recommended": null,
      "recommendation": "A shared family passcode; accounts are more than a family needs.",
      "answer": null,
      "decision": ""
    },
    {
      "id": "q5",
      "round": 2,
      "title": "Who can edit a recipe?",
      "body": "Editing someone else's recipe is where family apps usually start arguments.",
      "dependsOn": ["q2"],
      "status": "asking",
      "reopened": true,
      "options": [
        { "id": "a", "label": "Only its author" },
        { "id": "b", "label": "Anyone, with history" }
      ],
      "recommended": "b",
      "recommendation": "",
      "answer": null,
      "decision": ""
    },
    {
      "id": "q6",
      "round": 2,
      "title": "Where is it hosted?",
      "body": "",
      "dependsOn": ["q1", "q2"],
      "status": "researching",
      "options": [],
      "recommended": null,
      "recommendation": "",
      "answer": null,
      "decision": ""
    },
    {
      "id": "q8",
      "round": 2,
      "title": "How does the home screen look?",
      "body": "This one is easier to pick by looking.",
      "dependsOn": ["q1", "q3"],
      "status": "asking",
      "options": [
        { "id": "a", "label": "A plain list", "sketch": "sketch/q8-a.html", "width": 390, "height": 760 },
        { "id": "b", "label": "A grid of photos", "sketch": "sketch/q8-b.html", "width": 390, "height": 760 },
        { "id": "c", "label": "One featured recipe", "sketch": "sketch/q8-c.html", "width": 390, "height": 760 }
      ],
      "recommended": "b",
      "recommendation": "",
      "answer": null,
      "decision": ""
    },
    {
      "id": "q7",
      "round": 3,
      "title": "How are recipes shared outside the family?",
      "body": "",
      "dependsOn": ["q4"],
      "status": "waiting",
      "options": [
        { "id": "a", "label": "Public link" },
        { "id": "b", "label": "Export as PDF" }
      ],
      "recommended": "a",
      "recommendation": "",
      "answer": null,
      "decision": ""
    }
  ]
};
