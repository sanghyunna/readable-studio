# Report section layouts

Paste these snippets into `assets/template.html`. Use only the sections the
brief needs, then replace every `[REPLACE]` token with real content.

## Class inventory

`report`, `report-header`, `kicker`, `title`, `lead`, `meta-grid`,
`meta-item`, `exec-summary`, `summary-grid`, `summary-item`, `body-section`,
`section-kicker`, `section-title`, `body-grid`, `key-points`, `metric-card`,
`chart-panel`, `chart-placeholder`, `chart-axis`, `appendix`, `refs`,
`page-break`, `num`

## Cover / title block

```html
<header class="report-header">
  <p class="kicker">[REPLACE] Report type / status</p>
  <h1 class="title">[REPLACE] Report title</h1>
  <p class="lead">[REPLACE] One paragraph that states the subject, audience, decision, and scope.</p>
  <div class="meta-grid" aria-label="Report metadata">
    <div class="meta-item"><span>Prepared for</span>[REPLACE] Audience</div>
    <div class="meta-item"><span>Prepared by</span>[REPLACE] Author</div>
    <div class="meta-item"><span>Date</span>[REPLACE] Date</div>
    <div class="meta-item"><span>Version</span>[REPLACE] Draft / final</div>
  </div>
</header>
```

## Executive summary callout

```html
<section class="exec-summary" aria-labelledby="executive-summary">
  <p class="section-kicker">Executive summary</p>
  <h2 class="section-title" id="executive-summary">[REPLACE] The short version.</h2>
  <p>[REPLACE] Summarize the conclusion in 2-3 sentences. Make the recommendation or status obvious.</p>
  <div class="summary-grid">
    <div class="summary-item">
      <strong>[REPLACE] Finding one</strong>
      <p>[REPLACE] Evidence and implication.</p>
    </div>
    <div class="summary-item">
      <strong>[REPLACE] Finding two</strong>
      <p>[REPLACE] Evidence and implication.</p>
    </div>
    <div class="summary-item">
      <strong>[REPLACE] Finding three</strong>
      <p>[REPLACE] Evidence and implication.</p>
    </div>
  </div>
</section>
```

## Section with subheads

```html
<section class="body-section" aria-labelledby="section-name">
  <p class="section-kicker">01 / [REPLACE]</p>
  <h2 class="section-title" id="section-name">[REPLACE] Section headline.</h2>
  <h3>[REPLACE] Subhead</h3>
  <p>[REPLACE] Explain the point in concrete prose.</p>
  <h3>[REPLACE] Subhead</h3>
  <p>[REPLACE] Explain the second point, tradeoff, or implication.</p>
</section>
```

## Section with key points

```html
<section class="body-section" aria-labelledby="section-findings">
  <p class="section-kicker">02 / Findings</p>
  <h2 class="section-title" id="section-findings">[REPLACE] What the evidence shows.</h2>
  <div class="body-grid">
    <div>
      <p>[REPLACE] Lead with the strongest observation, then explain why it matters.</p>
      <ul class="key-points">
        <li>[REPLACE] Specific point with evidence.</li>
        <li>[REPLACE] Specific point with tradeoff or risk.</li>
        <li>[REPLACE] Specific point with next action.</li>
      </ul>
    </div>
    <aside class="metric-card" aria-label="Key metric">
      <span class="value">[REPLACE]</span>
      <span class="label">[REPLACE] Key metric label and timeframe</span>
    </aside>
  </div>
</section>
```

## Data table

```html
<section class="body-section" aria-labelledby="section-data">
  <p class="section-kicker">03 / Evidence table</p>
  <h2 class="section-title" id="section-data">[REPLACE] Data that supports the conclusion.</h2>
  <table>
    <caption>[REPLACE] Table title, source, and date.</caption>
    <thead>
      <tr>
        <th>Category</th>
        <th>Status</th>
        <th class="num">Current</th>
        <th class="num">Target</th>
        <th>Note</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>[REPLACE]</td>
        <td>[REPLACE]</td>
        <td class="num">[REPLACE]</td>
        <td class="num">[REPLACE]</td>
        <td>[REPLACE]</td>
      </tr>
    </tbody>
  </table>
</section>
```

## Metric / chart block

```html
<section class="body-section" aria-labelledby="section-chart">
  <p class="section-kicker">04 / Chart</p>
  <h2 class="section-title" id="section-chart">[REPLACE] Trend or comparison.</h2>
  <div class="chart-panel">
    <h3>[REPLACE] Chart title</h3>
    <p class="chart-note">[REPLACE] Units, source, and assumption note.</p>
    <div class="chart-placeholder" role="img" aria-label="[REPLACE] Chart description">
      <div class="bar" style="height: 42%;"></div>
      <div class="bar" style="height: 55%;"></div>
      <div class="bar" style="height: 68%;"></div>
      <div class="bar" style="height: 64%;"></div>
      <div class="bar" style="height: 78%;"></div>
      <div class="bar" style="height: 88%;"></div>
    </div>
    <div class="chart-axis" aria-hidden="true">
      <span>[REPLACE]</span>
      <span>[REPLACE]</span>
      <span>[REPLACE]</span>
    </div>
  </div>
</section>
```

## Appendix / references

```html
<section class="appendix page-break" aria-labelledby="appendix">
  <p class="section-kicker">Appendix</p>
  <h2 class="section-title" id="appendix">[REPLACE] Methodology and references.</h2>
  <ul class="refs">
    <li>[REPLACE] Source, assumption, or method.</li>
    <li>[REPLACE] Source, assumption, or method.</li>
    <li>[REPLACE] Source, assumption, or method.</li>
  </ul>
</section>
```
