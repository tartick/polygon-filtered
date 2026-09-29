# Polygon Filtered Feed — Design

**Date:** 2026-09-29
**Owner:** Steven Tartick (GitHub: `tartick`)

## Goal

Polygon's RSS feed (`https://www.polygon.com/feed/`) is now dominated by shovelware:
streaming clickbait, franchise film/TV churn, and game walkthroughs. Produce a
replacement RSS feed that contains only the articles Steven actually wants, which he
subscribes to in his RSS reader.

**Success:** a stable public URL
`https://tartick.github.io/polygon-filtered/feed.xml` that updates on its own, whose
items read like the "keep" column in Appendix A, and that rarely lets streaming
clickbait through.

## Taste profile (source of truth for the classifier)

What Steven said directly:
- The thing he hates most: streaming clickbait ("This 2014 action thriller is about to
  leave streaming", "124-minute action thriller back on streaming", "free on YouTube").
- He likes horror-related articles (games, film, and TV).
- He plays Magic: The Gathering — keep MTG articles.

Inferred from his sort of 75 real articles (Appendix A):
- **Keep:** video game news, reviews, analysis, and features; horror; notable film/TV
  news with genuine interest (Game of Thrones movie, Mummy 4, del Toro's Bioshock
  movie, film reviews like Digger); Lego; Magic: The Gathering.
- **Toss:** walkthroughs and guides; streaming clickbait; big-franchise churn (Marvel /
  Avengers / Spider-Man, DC / Lanterns, Star Wars); anime (Naruto, Dragon Ball);
  Pokémon TCG retail/scalper/Happy Meal stories; nostalgia retrospectives and
  "N Years Later, old thing is popular again" pieces (but a genuine new-game
  announcement like the Thief sequel is a keep); renewals of generic TV (Reacher, Futurama).

## Architecture

```
GitHub Actions (cron */30 + manual dispatch)
  └─ node src/run.mjs
       1. fetch polygon.com/feed/         (retry; server drops connections)
       2. parse items; skip ones already decided in data/items.json
       3. hard rules (config/rules.json)  → drop / keep / undecided
       4. Claude Haiku (one batched call) → keep/toss + reason for undecided
       5. write data/items.json, public/feed.xml, public/rejected.xml
  └─ commit data/ + public/ if changed
  └─ deploy public/ to GitHub Pages (actions/deploy-pages)
```

- **Repo:** `tartick/polygon-filtered`, public (required for free Pages), local path
  `~/Documents/Claude/polygon-filtered`.
- **Runtime:** Node 24 (ESM). Minimal dependencies: an XML parser
  (`fast-xml-parser`) and `@anthropic-ai/sdk`. Tests use the built-in `node:test`.
- **Why the 30-minute schedule matters:** Polygon's feed holds only the 10 newest items
  and does not paginate (`?paged=2` returns the same 10). At ~35–40 posts/day that is a
  ~5-hour window; polling every 30 minutes leaves ample slack for GitHub's cron delays.

## Components

Each unit is a small module with one job, testable in isolation.

| Module | Responsibility |
|---|---|
| `src/fetchFeed.mjs` | GET the Polygon feed with a browser-like User-Agent, up to 4 attempts with backoff. Returns raw XML string or throws. |
| `src/parseFeed.mjs` | Raw XML → array of items: `{ guid, title, link, creator, pubDate, categories[], description, contentEncoded, enclosure{url,type,length} }`. `guid` = link (Polygon items have no `<guid>`). |
| `src/rules.mjs` | `applyRules(item, rules)` → `{ decision: 'keep'|'toss'|null, reason }`. Drop rules are evaluated before keep rules. |
| `src/classify.mjs` | `classify(items, { taste, examples, client })` → map guid → `{ decision, reason }`. One batched Messages API call to `claude-haiku-4-5`, JSON output. `client` is injectable for tests. |
| `src/store.mjs` | Load/save `data/items.json`; merge new items; prune entries older than 30 days by `pubDate`. |
| `src/buildFeed.mjs` | Items → RSS 2.0 XML string. Preserves description, `content:encoded`, enclosure, categories, `dc:creator`. Rejected feed prepends the reason to the description. |
| `src/run.mjs` | Orchestrates the steps above. |

### Config / tuning files (plain text, edited by hand)

- `config/rules.json`
  - `dropCategories`: `["Guides"]`
  - `dropTitlePatterns` (case-insensitive regex), targeting streaming clickbait, e.g.
    `\b\d{2,3}-Minute\b`, `\bon streaming\b`, `(back|blasts back|returns?) (on|onto) streaming`,
    `free (to watch )?on YouTube`, `No\. ?1 on (Netflix|Prime Video|HBO Max|Hulu|Disney\+)`,
    `leaving (Netflix|Prime Video|HBO Max|Hulu|Disney\+)`.
  - `keepCategories`: `["Magic: The Gathering"]`
- `config/taste.md` — the taste profile above in plain English, fed to Claude.
- `config/examples.json` — Appendix A as `[{ title, decision }]`, fed to Claude as
  labeled examples. Adding a line here is the primary way to correct a misfire.

## Data

`data/items.json`: array of stored items (parsed fields + `decision`, `reason`,
`decidedBy: 'rule'|'claude'|null`, `firstSeen`). `decision: null` means pending.

## Outputs

- `public/feed.xml` — newest 50 kept items by `pubDate`, channel title
  "Polygon (filtered)", `atom:link rel=self` pointing at the Pages URL.
- `public/rejected.xml` — newest 50 tossed items, each description prefixed
  `[Filtered: <reason>]`, for auditing misfires.
- `public/index.html` — one-line page linking both feeds.

## Error handling

- **Polygon unreachable/malformed:** run exits non-zero without touching files; the
  previously deployed feed stays live.
- **Claude API error or unparsable response:** new items are stored with
  `decision: null` and retried next run (they are stored, so falling out of Polygon's
  10-item window doesn't lose them). Rule-decided items are still written.
- **Missing `ANTHROPIC_API_KEY`:** same as API error, plus a clear log line.
- Workflow uses a `concurrency` group so runs never overlap.

## Testing

- Unit tests (`node --test`) for `parseFeed`, `rules` (every Appendix A title that
  should hit a drop pattern does; none of the keep titles do), `store` pruning/merge,
  `buildFeed` (valid XML, round-trips through `parseFeed`), and `classify` with a
  fake client (request contains taste + examples; malformed response → all pending).
- Fixture: `test/fixtures/polygon-feed-2026-09-29.xml` (real feed captured today).
- Before enabling the schedule: one live local dry run with a real key
  (`--dry-run` prints decisions without writing files).

## Setup steps for Steven (at the end)

1. Create an API key at console.anthropic.com.
2. Run `gh secret set ANTHROPIC_API_KEY --repo tartick/polygon-filtered` and paste the
   key at the prompt (never in chat).
3. Add `https://tartick.github.io/polygon-filtered/feed.xml` to the RSS reader.

## Risks / notes

- GitHub pauses scheduled workflows in repos with 60 days of no activity; the bot's
  own commits keep the repo active in practice.
- Polygon could block GitHub runner IPs; if so, fall back to a Cloudflare Worker or
  Vercel cron (out of scope now).
- Out of scope: web UI for sorting, backfilling from Polygon's news sitemap, multiple
  source sites.

## Appendix A — labeled examples (Steven's sort, 2026-09-29)

KEEP
- Magic’s KPop Demon Hunters Secret Lair Is Coming Sooner Than You Think
- God of War Laufey Is Quietly a Preview of PlayStation's Future
- 'Game of Thrones' Officially Returns in 2029 with First Movie
- An NFL Legend Is About to Reveal the Minecraft City He Spent 12 Years Building
- Xbox’s Platinum Trophy Equivalent Officially Revealed
- 'GTA 6' Fans Are Hammering the Game Informer App Into Oblivion Right Now
- Lego Officially Retiring Star Wars and X-Men Sets in 2026
- The Witcher 3 Remastered Is Officially the Best-Reviewed Game of the Year
- Guillermo Del Toro Officially Confirms He Almost Directed the Bioshock Movie
- Nintendo Officially Launches Zelda 40th Anniversary Concert Ticket Sales
- Digger is the most important movie of the century, but I can't tell you why
- Thief Gets a New Sequel 30 Years Later — Here's a First Look
- Critical Role's New Game Announced for 2027 (Exclusive)
- Blizzard Promises 'Diablo 4' Support Even After 'Diablo 5' Launches
- 'The Witcher 3 Remastered' Pirates Are Encouraging Each Other To Buy It Instead
- The Mummy 4 Set Photos Reveal Brendan Fraser’s Official New Look
- The Mummy 4 Set Photos Show First Look at Rachel Weisz's Return (relabeled keep for consistency with the Fraser photos)
- Fortnite’s Halloween Event Is Officially Jam-Packed With Horror Franchises
- The Witcher 3’s Next Big Expansion Just Released a Glimpse Into Its World
- The Next Monster Hunter Game Officially Gets a Release Date
- Naughty Dog Has Two The Last of Us Projects in Development
- Lego Reveals First Dragon Ball Set with Shenron and Kid Goku
- 'The Exorcist: Martyrs' Is Mike Flanagan's "Scariest Thing" Ever, Cast Member Says
- Beloved 2025 Game About Digging Holes Gets Sequel Announcement
- Fire Emblem: Fortune's Weave Is the Rare RPG that Tackles Religion Correctly
- Best-Selling Game About Shooting Fish Unveils First Major Update
- Xbox Disc-to-Digital Program Keeps Getting Larger, Adding Big Publisher
- How to Finally Get Over the Urge to Restart BG3
- Fire Emblem Just Completely Shook Up a Tired RPG Villain Twist
- Switch Finally Gets One of 2025’s Best-Reviewed RPGs
- GTA 6’s $400 Collector’s Edition Is the Latest Example of a Horrible Trend
- Dressmaker's Chaotic Evil Endings Prove Why it's Dominating Steam Right Now
- Naughty Dog Officially Celebrates Last of Us Day with DLC
- Blizzard's MOBA Is Making An Unexpected Comeback
- Control Resonant Proves Everything Is a Live-Service Game Now
- New 'Pokémon Winds and Waves' Leaks Fill Major Gap Left by Game Freak's Silence
- Here’s Every Change in the Witcher 3 Remastered
- Steam Dev’s Viral GTA Clone Is The Perfect PS2 Throwback
- Super Mario Galaxy on PC Is Officially One Step Closer to Being Reality
- Backrooms Director Reveals Where the Series Should Go Next
- GTA 6 Officially Won't Break Clair Obscur's GOTY Record
- Blizzard Scrambles to Meet World of Warcraft Forever’s Unexpected Popularity
- 'God of War Laufey' Footage Officially Reveals New Gameplay, Physical Edition
- The Witcher 3 Remastered Is Still An Unfinished Masterpiece
- Minecraft Dungeons 2 Goes from Good Baby Diablo to Great Junior Diablo
- Toem 2 Is Somehow Even More Perfect Than Toem
- Fortnite's Spooky Month Kicks off With Five Nights at Freddy's Crossover
- 2024's Best RPG Is a Must-Play for Fire Emblem Fans

TOSS
- Brendan Fraser's 124-Minute Action Thriller Classic Is Back From the Dead on Streaming
- Avatar: Seven Havens Episode Titles Revealed (Exclusive)
- Avengers: Doomsday Directors Confirm Hulk’s Fate After Endgame Encore
- Avengers: Endgame Writer Reveals Alternate Fate for a Major Character
- New Naruto Anime Project Finally Resurfaces Ahead of Big Announcement
- 29 Years Ago, 'Buffy' Introduced Its Best Villain. He Was Never Meant to Last.
- Spider-Man: Brand New Day Getting Official New Version, Report Says
- Pokémon TCG's Next Big Set Available Weeks Before It Officially Releases
- Predator: Badlands Director is Taking on a New Disney Reboot
- Reacher Officially Renewed for Season 6 on Prime Video
- Forget 'Delicious in Dungeon,' This Cozy Fantasy Graphic Novel Hits the Same Notes
- Russell Crowe’s New Crime Thriller Is Already No. 1 on Netflix
- Target's Pokémon 30th Anniversary Event Leaves Parents Angry and Confused
- 16 Years Later, A 'Let's Play' Classic Blows Up on Steam with 750K Wishlists
- 'Get Jiro' Review: Adult Swim’s Anthony Bourdain’s Adaptation Is Best When it Focuses on the Food
- Why Star Wars Fans Are Furious Over the Next Skywalker Saga Movie
- New Target 'Pokémon' Card System Will Make Collectors Very Happy
- Star Wars' Most Cunning Villain Officially Returns in New Release | Exclusive Preview
- 'Futurama' Showrunner Officially Confirms the Sci-Fi Series' Surprising 2027 Plans
- Pokémon's 30th Anniversary Happy Meal Toy Will Unleash Scalper Hell
- Dragon Ball Super: Beerus Episode Count and Streaming Details Teased by New Leaks
- 35 Years Later, the '90s Remake of a Cult Classic Thriller Is Officially Free to Watch on YouTube
- The Definitive ’90s Sci-Fi Action Blockbuster Is Officially Streaming for Free on YouTube
- 'Lanterns' Episode 7 Ending Explained: Antaan, Sinestro, and Who Killed Hal Jordan?
- HBO Just Officially Changed a Fundamental Rule of Green Lantern Canon
- Jason Statham’s 113-Minute Action Thriller Blasts Back Onto Streaming
- All paralogue dates and deadlines in Fire Emblem Fortune's Weave (Guides tag)
