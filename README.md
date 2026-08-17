# Regional Mobility ABM (Central Macedonia) — Live Lite

A browser-based **synthetic-population demonstration example** derived from a private regional mobility agent-based model developed within MOBI-TWIN.

**Live model:** https://junyaohe001.github.io/mobi-twin-ABM-lite/

The page runs a stochastic simulation directly in the browser. It does **not** reproduce the private empirical model in full. It retains selected mobility, population-change, transition, remote-work, congestion, and social-influence mechanisms while using disclosure-reduced public inputs.

## Public interface

- Five macro scenarios: Baseline, Leapfrog, Dark Horse, Snailpace, and Lion's Den.
- Default run: seed 66, 600 synthetic agents, 120 months.
- One macro scenario is simulated at a time.
- **No Transition (NT)** and **Twin Transition (TT)** are simulated in parallel from the same synthetic initial population.
- Behavioural sliders remain available for exploratory interaction.
- Synthetic-agent point locations are not displayed.
- Only aggregate national trajectories and regional snapshots can be downloaded.

## Privacy boundary

This public repository contains only disclosure-reduced synthetic archetypes, clustered behavioural profiles, simplified regional geometry, rounded public parameters, and aggregate-output code. It does not contain original sample rows, original identifiers, donor identifiers, source-row mappings, private model files, local paths, or agent-level snapshots.

No original sample personal information is published. The synthetic-data workflow is an engineering disclosure-reduction process; it is not presented as formal differential privacy or legal certification of anonymisation.

## Interpretation

This is a **demonstration example** for communication and exploratory interaction. It has not been numerically calibrated against the private NetLogo batch outputs for public release, and no claim of substantive equivalence is made. Formal findings continue to rely on the private desktop model.

## Repository structure

```text
index.html                 Interactive browser model
assets/app.js              Simulation and visualisation logic
assets/styles.css          Interface styling
data/                      Disclosure-reduced public inputs only
docs/                      Scope, privacy, preparation and validation notes
```

## Local preview

A local web server is required because the page loads JSON files with `fetch`:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000/`.

## Data use

See [DATA-USE-NOTICE.md](DATA-USE-NOTICE.md). No licence is granted beyond what is explicitly stated there.
