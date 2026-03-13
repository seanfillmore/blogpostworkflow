# Ahrefs Data Folder

Drop CSV exports from Ahrefs here. One subfolder per keyword (use the hyphenated slug).

## Folder structure

```
data/ahrefs/
  best-natural-deodorant-for-women/
    serp.csv            ← SERP Overview export
    matching_terms.csv  ← Matching Terms (or Related Terms) export
    keyword.csv         ← Volume History export (optional, adds seasonality)
  best-natural-deodorant-for-men/
    serp.csv
    matching_terms.csv
    keyword.csv
```

## How to export from Ahrefs

### SERP Overview → serp.csv
1. Keywords Explorer → enter keyword → SERP Overview tab
2. Click Export (top right) → CSV
3. Save as `serp.csv` in the keyword subfolder

### Matching Terms → matching_terms.csv
1. Keywords Explorer → enter keyword → Matching Terms tab
2. Filter: KD ≤ 40, Volume ≥ 100
3. Click Export → CSV
4. Save as `matching_terms.csv` in the keyword subfolder

### Volume History → keyword.csv (optional)
1. Keywords Explorer → enter keyword → Overview tab
2. Click the volume chart → Export → CSV
3. Save as `keyword.csv` in the keyword subfolder
4. Used to detect seasonal peaks and inform content timing notes

## Supported column names

The loader handles Ahrefs' default column names automatically:
- SERP: `#`, `URL`, `Title`, `DR`, `Traffic`, `Keywords`, `Domains`
- Keywords: `Keyword`, `Volume`, `KD`, `Traffic Potential`, `CPC`
