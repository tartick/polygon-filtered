# polygon-filtered

Polygon.com's RSS feed, minus the shovelware.

- **Subscribe:** https://tartick.github.io/polygon-filtered/feed.xml
- **Audit what got filtered:** https://tartick.github.io/polygon-filtered/rejected.xml

## How it works

Every 30 minutes a GitHub Action fetches https://www.polygon.com/feed/ (it only
ever holds the 10 newest articles), and for each article it hasn't seen before:

1. **Hard rules** (`config/rules.json`) — drops anything tagged `Guides` and
   streaming-clickbait headlines; always keeps `Magic: The Gathering`.
2. **Claude Haiku** judges everything else against `config/taste.md` and the
   labeled examples in `config/examples.json`.

Decisions are stored in `data/items.json` (30 days), and the kept / tossed
articles are published to GitHub Pages.

## Tuning

- Wrong call? Add the headline to `config/examples.json` with the right
  `decision`, or adjust `config/taste.md`, then commit and push.
- Past decisions aren't re-judged. To re-judge an article, set its `decision`
  to `null` in `data/items.json`.

## Local use

    npm install
    npm test
    ANTHROPIC_API_KEY=... npm run dry-run   # print decisions, write nothing
