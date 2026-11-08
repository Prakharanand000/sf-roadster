# Vegetation species kits and park communities (MAP side research)

Researched 2026-10-26. Counts were queried live from Socrata. Anything tagged UNCONFIRMED comes from general horticultural knowledge with no page fetched. "Cited" means the fetched page said it.

## 1. Data facts and caveats

- SF Street Tree Inventory `tkzw-k3nq`: 144,522 rows, 1,222 with a null `species`. Species strings are `Latin :: common`. https://data.sf.gov/resource/tkzw-k3nq.json?$select=species,count(*)&$group=species&$order=count(*)%20DESC&$limit=40
- `mapdbh` is a TEXT column (SoQL `avg()` fails on it), in inches. A value of 100 is not a placeholder max for many species: only 65 rows dataset-wide are 100, and species maxima exceed 100 (cypress 105, blue gum 106, London plane 125), though some large values may be errors (unconfirmed) (corrected 2026-10-26). Cap at about 60 in or clip at p95. Median and p90 below were computed client-side from the raw rows.
- `dbhrange` is only 1/2/3 in the top rows (93k / 33k / 18k), too coarse to use. Use `mapdbh`.
- `plotsize` is a text field (plot dimensions), usable as a crown-room hint.
- Oakland Trees Along Sidewalks `svwc-9r23`: 42,666 rows, 2006 survey, no licence stated (Socrata `license` is null: https://data.oaklandca.gov/api/views/svwc-9r23.json). Species are free-text and inconsistent (`Platanus acerifolia`, `Pyrus calleryana cvs`, `Quercus sp`). Size is a class (`trunkdiam`: Small 13,257 / Medium 11,244 / Large 9,648 / None 4,706 / X-large 2,333 / XX-large 1,473). Row 1 also carries a `trunkdia_n` numeric class. 4,053 rows are "Tree well only" (empty pits, not trees) and 452 are "Dead". Filter both out.
- Oakland licence is unclear, so ship only derived species-class statistics from it. For the redistributable Oakland set use `4jcx-enxf` (2015, CC0, per MAP_RESOURCES.md).
- Tree heights are not in either dataset. The kit heights below are size priors. Replace them per tree with a lidar canopy height model (section 5).

## 2. SF top species (street trees)

| # | Species | Common | Count | Median / p90 DBH (in) | Notes |
|---|---|---|---|---|---|
| 1 | Platanus x hispanica | London plane | 8,941 | 10 / 20 | Largest deciduous street tree |
| 2 | Lophostemon confertus | Brisbane box | 6,972 | 7 / 15 | |
| 3 | Metrosideros excelsa | NZ Christmas tree | 6,971 | 11 / 18 | |
| 4 | Tristaniopsis laurina | Swamp myrtle | 6,424 | 3 / 9 | Young, recent plantings |
| 5 | Pittosporum undulatum | Victorian box | 5,579 | 9 / 16 | |
| 6 | Magnolia grandiflora | Southern magnolia | 5,235 | 4 / 12 | |
| 7 | Ficus microcarpa nitida 'Green Gem' | Indian laurel fig | 4,984 | 13 / 20 | |
| 8 | Prunus cerasifera | Cherry plum | 4,704 | 5 / 10 | Max DBH 31 in, short-lived |
| 9 | Arbutus 'Marina' | Strawberry tree hybrid | 3,966 | 4 / 11 | |
| 10 | Prunus serrulata 'Kwanzan' | Flowering cherry | 3,013 | not measured | |
| 11 | Olea europaea | Olive | 2,905 | 5 / 13 | |
| 12 | Acacia melanoxylon | Blackwood acacia | 2,790 | 13 / 24 | |
| 13 | Maytenus boaria | Mayten | 2,701 | 7 / 14 | |
| 14 | Callistemon citrinus | Lemon bottlebrush | 2,698 | not measured | Small tree, shrubby |
| 15 | Ginkgo biloba | Ginkgo | 2,556 | 3 / 9 | Young |
| 16 | Corymbia ficifolia | Red flowering gum | 2,489 | 18 / 30 | |
| 17 | Pyrus calleryana | Ornamental pear | 2,157 | 5 / 12 | |
| 18 | Eriobotrya deflexa | Bronze loquat | 1,903 | not measured | |
| 19 | Ulmus parvifolia | Chinese elm | 1,812 | 7 / 18 | |
| 20 | Cupressus macrocarpa | Monterey cypress | 1,694 | 28 / 50 | Largest street trees |
| 21 | Ligustrum lucidum | Glossy privet | 1,631 | 9 / 16 | |
| 22 | Pinus radiata | Monterey pine | 1,563 | 22 / 43 | Sparse tops at age |
| 23 | Cordyline australis | Cabbage tree ("Dracena palm") | 1,492 | not measured | |
| 24 | Prunus serrulata | Ornamental cherry | 1,340 | not measured | |
| 25 | Juniperus chinensis | Juniper | 1,274 | not measured | |

Ranks 26 to 28 are Pittosporum crassifolium (1,263), Melaleuca quinquenervia (1,253) and Pyrus kawakamii (1,234). Not in the top 25 but important for landmarks and parks (counts are `like 'Genus%'` totals):

| Species | SF count | Median / p90 DBH (in) |
|---|---|---|
| Eucalyptus (all, incl. polyanthemos 713, sideroxylon 479, globulus 415, citriodora 176) | 2,304 | globulus 25 / 45 |
| Washingtonia robusta (Mexican fan palm) | 782 | 15 / 21 |
| Phoenix canariensis (Canary Island date palm) | 595 | 30 / 90 (trunk placeholders) |
| Quercus agrifolia (coast live oak) | 546 | 3 / 13 |
| Sequoia sempervirens | 288 | 7 / 27 |
| Cupressus (all) | 1,842 | |
| Pinus (all) | 2,430 | |

## 3. Oakland top species (svwc-9r23, name as recorded, tree wells and dead excluded)

| Species | Count |
|---|---|
| Platanus acerifolia (London plane) | 3,788 |
| Liquidambar styraciflua | 3,312 |
| Pyrus calleryana cvs | 2,683 |
| Prunus cerasifera/blireiana | 2,048 |
| Lagerstroemia indica (crape myrtle) | 1,953 |
| Pyrus kawakami | 1,427 |
| Magnolia grandiflora | 1,375 |
| Fraxinus o. 'Raywood' | 1,327 |
| Pistacia chinensis | 1,150 |
| Acer sp | 971 |
| Prunus sp | 882 |
| Fraxinus sp | 824 |
| Lophostemon confertus | 632 |
| Ginkgo biloba | 576 |
| Celtis sp | 567 |
| Crataegus phaenopyrum | 549 |
| Cinnamomum camphora | 522 |
| Quercus sp (+ agrifolia 141, ilex 58, suber 32) | 479 |
| Podocarpus gracilior | 425 |
| Cercis sp | 421 |
| Schinus terebinthifolia | 370 |
| Jacaranda | 365 |
| Ulmus parvifolia | 345 |
| Tristaniopsis laurina | 313 |
| Washingtonia robusta | 274 |
| Phoenix canariensis | 188 |
| Sequoia sempervirens | 48 |

Oakland is more deciduous and cold-season-coloured than SF: sweetgum, pear, ash, Pistacia, crape myrtle and Raywood ash give red, orange and yellow fall colour. SF is dominated by evergreens.

## 4. Species kits (growth form, size, seasonal colour, bark, procedural parameters)

Heights and spreads for city trees are UNCONFIRMED priors unless a URL is cited. Wikipedia gives the wild or maximum range. Use it as the cap, not the typical city height.

Parameter key: `H` mature city height (m), `W` crown width (m), `T` trunk-to-crown ratio (clear trunk height / H), `shape` crown primitive, `leaf` summer RGB-ish colour, `fall` seasonal change, `bark` base colour and texture, `density` canopy opacity (0 to 1).

| Species | Form | Evergreen | Cited facts | H / W / T / shape | Leaf colour by season | Bark | Procedural notes |
|---|---|---|---|---|---|---|---|
| London plane | Large spreading, often pollarded | Deciduous | 20-40 m wild, to 50 m; leaves 10-20 cm palmate; bark pale grey-green, smooth and peeling, or buff-brown ([wiki](https://en.wikipedia.org/wiki/Platanus_%C3%97_acerifolia)) | 18-25 / 14-18 / 0.35 / broad ovoid; pollarded = 8-12 m with club branches | Spring bright yellow-green, summer mid green, fall yellow-brown, winter bare | Mottled cream/olive/grey patches | Bare-branch winter variant needed; pollarded variant with stubby knuckles on a clipped sidewalk row |
| Brisbane box | Dense dome | Evergreen | Dome-shaped, dense, dark green leathery leaves, more shade than eucalyptus ([wiki](https://en.wikipedia.org/wiki/Lophostemon_confertus)); street trees stay far below the wild 40 m | 10-15 / 7-10 / 0.3 / dome | Dark green all year | Rough, red-brown, shaggy (UNCONFIRMED) | Clustered leaves at twig ends; low saturation, dark |
| NZ Christmas tree | Multi-trunk spreading dome | Evergreen | Up to 25 m, dome-shaped, usually multi-trunk, leaves white-hairy beneath, crimson flowers Nov-Jan, peak mid-late Dec ([wiki](https://en.wikipedia.org/wiki/Metrosideros_excelsa)) | 8-14 / 8-12 / 0.2 / wide dome | Grey-green (white underside shows in wind), red flower dots Dec-Jan | Fibrous, aerial roots on trunks | Add red flower sprites in Dec; thick low branching |
| Swamp myrtle | Narrow/upright small | Evergreen | 4.6-9.1 m in cultivation (to 39 m wild), yellow flowers late spring ([wiki](https://en.wikipedia.org/wiki/Tristaniopsis_laurina)) | 5-9 / 3-5 / 0.3 / oval | Dark green, yellow bloom in May-Jun | Smooth, mottled pale, peeling (UNCONFIRMED) | Median DBH 3 in: most are young, so scale towards the small end |
| Victorian box | Dense rounded | Evergreen | Up to 15 m, lance leaves with wavy edges, spring fragrant flowers ([wiki](https://en.wikipedia.org/wiki/Pittosporum_undulatum)) | 7-12 / 6-9 / 0.25 / dense round | Glossy mid-green | Grey-brown, smooth (UNCONFIRMED) | |
| Southern magnolia | Pyramidal | Evergreen | To 27.5 m (up to 37 m), pyramidal, leaves 12-20 cm dark and leathery with rusty underside, white flowers late spring ([wiki](https://en.wikipedia.org/wiki/Magnolia_grandiflora)) | 9-15 / 6-9 / 0.2 / pyramid-ovoid | Very dark glossy green year-round | Smooth grey to scaly dark | Large leaf cards; dense; low saturation |
| Indian laurel fig 'Green Gem' | Dense rounded, aggressive roots | Evergreen | Wild 25 m (to 35); widely used coastal-CA street tree, roots lift pavement ([wiki](https://en.wikipedia.org/wiki/Ficus_microcarpa)) | 9-14 / 9-14 / 0.25 / very dense dome, low-hanging | Glossy dark green, new growth lighter | Smooth grey, buttress roots | Often clipped tight: a smooth "mushroom" dome, trimmed for lamps and wires |
| Cherry plum | Small rounded | Deciduous | UNCONFIRMED | 5-8 / 5-7 / 0.3 / round | Purple-red leaves (var. atropurpurea), pink-white bloom late winter, bare in winter | Dark grey | Pink-flower spring variant |
| Strawberry tree 'Marina' | Small round | Evergreen | UNCONFIRMED | 6-9 / 5-7 / 0.25 / round | Dark green with red new growth | Reddish-brown peeling | Often multi-trunk |
| Kwanzan cherry | Vase | Deciduous | UNCONFIRMED | 6-9 / 6-9 / 0.3 / vase | Pink bloom Mar-Apr, bronze-green summer, orange-yellow fall | Reddish-brown with lenticels | Short bloom window: a texture swap |
| Olive | Gnarled low-spreading | Evergreen | UNCONFIRMED | 5-9 / 5-8 / 0.2 / irregular rounded | Silver-grey green (blue-grey underside) | Grey, twisted | Twisted multi-stem trunks; lower saturation than other evergreens |
| Blackwood acacia | Upright, irregular | Evergreen | 6-30 m; phyllodes 40-160 mm, dark green; bark hard, fissured, dark grey to black; cream-yellow balls Jul-Dec ([wiki](https://en.wikipedia.org/wiki/Acacia_melanoxylon)) | 12-18 / 7-10 / 0.35 / upright-oval | Dark green | Dark fissured | Often leans; suckers |
| Mayten | Weeping | Evergreen | UNCONFIRMED | 6-10 / 5-8 / 0.25 / weeping | Bright green | Grey | Drooping branchlets |
| Ginkgo | Narrow-conical, young | Deciduous | UNCONFIRMED | 8-15 / 4-8 / 0.4 / conical | Fan-green summer, bright yellow in Nov, bare in winter | Grey-brown ridged | Median DBH 3 in: use a small, young size. Fall yellow drops all at once. |
| Red flowering gum | Spreading, "straggly" | Evergreen | Typically about 10 m; rough fibrous brown bark; red, pink or orange flowers Dec-May ([wiki](https://en.wikipedia.org/wiki/Corymbia_ficifolia)) | 8-14 / 8-12 / 0.3 / irregular | Grey-green | Rough, fibrous brown | Flower sprites in orange-red, Dec-May |
| Ornamental / Callery pear | Oval to pyramidal | Deciduous | UNCONFIRMED | 8-12 / 5-8 / 0.3 / oval | White bloom Mar, green summer, red-purple fall | Grey-brown, rough | |
| Chinese elm | Spreading vase | Semi-deciduous | UNCONFIRMED | 10-16 / 10-14 / 0.35 / vase | Green; leaves hold until Dec-Jan | Flaking mottled orange/grey | |
| Monterey cypress | Conical/columnar young, flat-topped and windswept old | Evergreen | Up to 40 m, trunk to 2.5 m, strong wind gives an irregular flat top; dense bright-green sprays smelling of lemon; endemic only to Cypress Point and Point Lobos ([wiki](https://en.wikipedia.org/wiki/Cupressus_macrocarpa)) | 15-30 / 10-20 / 0.3 / conical to flat-top | Dark to bright green all year | Reddish-brown, fibrous, deeply furrowed (UNCONFIRMED) | Wind-sheared lean away from the ocean at Ocean Beach, GGP west end and Presidio coast: bake lean from prevailing WNW wind. |
| Monterey pine | Pyramidal young, rounded and open when old | Evergreen | 15-30 m wild, to 60 m cultivated; branches up, rounded top; needles bright green, 8-15 cm, in threes; bark fissured dark grey-brown; lifespan about 80 to 90 years (citation needed) ([wiki](https://en.wikipedia.org/wiki/Monterey_pine)) | 20-35 / 10-18 / 0.5 / rounded umbrella when old | Bright green needles all year | Deep fissured dark grey | Needle clumps at branch tips; dead-top and bare-branch variants for old stands |
| Blue gum | Very tall, narrow-rounded | Evergreen | 30-55 m; juvenile leaves bluish-waxy, adult glossy dark green 15-30 cm; bark smooth white-cream with persistent slabs at the base; white flowers ([wiki](https://en.wikipedia.org/wiki/Eucalyptus_globulus)) | 30-50 / 12-20 / 0.6 / tall oval, open | Grey-green blue cast; drooping | Smooth cream-white upper trunk, ragged shed ribbons at the base | Add shed bark litter on ground, strips hanging from trunk; open crown |
| Coast live oak | Broad spreading, often multi-trunk | Evergreen | UNCONFIRMED | 8-15 / 12-20 / 0.2 / wide dome, low horizontal limbs | Dark green, grey underside | Dark grey, furrowed | Wide, low-branching; in wild groves canopies merge |
| Redwood | Tall narrow conical | Evergreen | See sections 5-6 | 25-60 / 8-12 / 0.5 / conical | Blue-green to dark green | Reddish-brown, soft, deeply fibrous-furrowed | Park stands, not street |
| Palms: Canary Island date palm | Massive crown on a single trunk | Evergreen | UNCONFIRMED | 10-18 trunk / 8-10 crown / pineapple-like trunk base | Dark green fronds | Diamond leaf-base scars | Crown sphere, not a branched tree |
| Mexican fan palm | Tall thin trunk, small crown | Evergreen | UNCONFIRMED | 15-25 / 3-4 / skirt of dead fronds | Grey-green fronds | Grey | Thin stick + frond skirt. Mostly along medians, plazas. |
| Cabbage tree (Cordyline) | Low branching palm-like | Evergreen | UNCONFIRMED | 4-8 / 3-5 | Green, spiky; white bloom in Jun | Rough | |
| Liquidambar (Oakland) | Conical-oval | Deciduous | UNCONFIRMED | 15-25 / 8-12 / conical | Green; red, orange and purple in Nov | Grey, corky ridges | Strong fall colour swap |
| Crape myrtle (Oakland) | Small vase, multi-trunk | Deciduous | UNCONFIRMED | 4-7 / 3-5 | Pink, red or white flowers Jul-Sep; fall orange-red | Smooth mottled tan | |

### Seasonal approach (cheap)

- Evergreen kits: do not change leaf colour. The only seasonal change is the flower sprite layer (red/pink in Dec to Jan for NZ Christmas tree and flowering gum).
- Deciduous: lerp the leaf colour with a season uniform. Order: bud green (Apr) -> mid green (Jun-Sep) -> yellow/orange/red (Nov) -> bare (Dec-Mar). Bay Area deciduous street trees colour late (Nov to early Dec) and drop by about mid Dec: UNCONFIRMED, general local knowledge.
- Winter bare variants matter most for London plane (3,788 Oakland, 8,941 SF), ginkgo, cherry/plum, pear, sweetgum, Raywood ash.

### Procedural parameter recipe

1. Pick a kit by species string (match on the Latin genus + species, then cultivar).
2. Height `h`: if a lidar CHM value exists at the tree's point, use it directly. Otherwise `h = clamp(Hmin + (Hmax - Hmin) * f(DBH))` where `f` is the percentile of that species' DBH distribution.
3. Crown width `w = h * (W/H)` with +/-15% jitter. Trunk radius from DBH (inches * 0.0254 / 2). DBH from the inventory is at breast height (1.37 m, UNCONFIRMED but standard).
4. Crown primitive from the shape column, with 2 to 3 lobes at randomised offsets for irregular species. Lean from wind for cypress and pine on the coast.
5. Leaf and bark colours as above, with per-instance +/-8% value jitter.
6. Use impostor billboards past about 150 m and one low-poly mesh per kit before that. Instance with one draw per kit.

## 5. Using lidar canopy heights to place and size park trees

The USGS 3DEP lidar listed in MAP_RESOURCES.md (SF 2023 at ~44 pts/m2; this is total/first-return pulse density; measured on real points 2026-10-26: 121–154 pts/m² all returns and 31–42 pts/m² ground (class 2) over mixed SF blocks, see lidar-probes.md §1; Alameda 2021 QL1) is public domain. (corrected 2026-10-26)

- CHM = first-return surface (DSM) minus bare-earth DTM, built from first returns of unclassified (class 1) points minus the DTM, masked by building footprints, because the SF B23 and Alameda projects deliver no vegetation classes (only 1, 2, 7, 9, 17, 18, 20) (corrected 2026-10-26). This is the standard definition. The search I ran did not directly confirm it, so treat it as UNCONFIRMED in terms of a citation, but it is the usual practice ([USDA tree-detection study](https://research.fs.usda.gov/treesearch/24611)).
- Detection: smooth the CHM (Gaussian, about 1 m) and take local maxima above about 3 m inside a moving window of about 3 x 3 m; one study uses exactly the maximum in a 3 m x 3 m cell as the treetop ([ISPRS 2016](https://isprs-archives.copernicus.org/articles/XLI-B8/563/2016/)). Window size scales with height (about 0.1 x height).
- Accuracy depends on type: in a Korean study extended-maxima + watershed found about 87% of larch, about 68% of Korean pine and about 67% of oak ([Kwak et al.](https://scholar.korea.ac.kr/handle/2021.sw.korea/125651)), with height R2 about 0.74 to 0.80. Conifers with a sharp top (Monterey cypress, redwood) are easier to detect than round broadleaf crowns (oak, fig, laurel), which tend to merge or split.
- Practical consequences:
  - Dense groves (Presidio, Sutro, Mt Davidson, Joaquin Miller) do not need per-tree accuracy. Use local maxima for tree positions and height, watershed crown area for width, and a species chosen from the habitat polygon (section 6).
  - Street trees: do NOT take positions from lidar. Take them from the inventory points and use the CHM only to set height, since street trees sit within tall buildings. Snap each inventory point to the highest CHM cell within about 3 m that is not in a building footprint.
  - The CHM includes trees over roofs and under-bridge clutter. Mask building footprints and road-bridge decks before the detection.
  - Foliage season: the 2023 SF and 2021 Alameda flights are leaf-on or leaf-off by date (the acquisition dates were not checked: UNCONFIRMED). Deciduous trees measured leaf-off will read lower in the CHM, and lidar returns penetrate sparse crowns (eucalyptus, pine).
  - Trees planted after the survey year (2021/2023) are missing, and trees removed since still appear. Reconcile with the inventory `planteddate` field.
  - Pruned or pollarded planes read correctly in the CHM; no extra rule needed.

## 6. Park, hillside and open-space communities

| Area | Dominant vegetation | Facts | Source |
|---|---|---|---|
| Presidio | Even-aged planted forest: Monterey cypress, Monterey pine, blue gum, also redwood | Planned in 1883 by Maj. W. A. Jones as wind barrier and boundary; about 100,000 trees planted 1886-1910; about 75,000 trees on 306 acres; five species are 90% (cypress, pine, blue gum, blackwood acacia, redwood) (corrected 2026-10-26); blue gum about 42% to nearly half of the historic forest; cypress and pine are declining together | [Presidio fact sheet](https://wp.presidio.gov/wp-content/uploads/2023/07/Forestry-Program-Fact-Sheet-June-2023-Accessible.pdf), [Bay Nature](https://baynature.org/article/presidios-forest-resists-the-sands-of-time/), [NPS](https://www.nps.gov/goga/blogs/planting-with-a-purpose-eucalyptus-and-the-u-s-army.htm) |
| Golden Gate Park | Monterey pine (inland) and Monterey cypress (nearer the ocean) on former dune; later oaks, eucalyptus, redwoods | Hall reported 22,000 trees planted by 1873; McLaren (superintendent from 1887) used sea-bent grass first, then pines and cypress; Stow Lake pines date from the late 1870s; "Uncle John's Tree" Monterey cypress about 1880 at McLaren Lodge. Oak Woodlands are the city's most extensive native coast live oak woodland | [Wikipedia](https://en.wikipedia.org/wiki/Golden_Gate_Park), [Atlas Obscura](https://www.atlasobscura.com/places/uncle-johns-tree-mclaren-lodge), [SFRPD oak woodlands](https://www.sfrecpark.org/DocumentCenter/View/8534/615OakWoodlands) |
| Sutro Forest (Mt Sutro, UCSF) | Blue gum eucalyptus, some Monterey pine and cypress | Sutro began planting in 1886; the reserve is 61 acres with another 19 acres of city land; older trees exceed 100 ft (30 m); logged 1909-1934 and again in WWII; forest in decline and overgrown | [Wikipedia](https://en.wikipedia.org/wiki/Mount_Sutro), [UCSF](https://www.ucsf.edu/cgr/cgr-projects/mount-sutro-open-space-reserve) |
| Mt Davidson | Blue gum forest, about 30 of the 40 acres | Natural Area of 40.2 acres; forest covers three-quarters of it; blue gum forest 29.96 acres; planned partial thinning. Planted by Sutro | [SFRPD plan](https://sfrecpark.org/DocumentCenter/View/8521/62MountDavidson), [Jacquie Proctor](https://jacquieproctor.com/articles/the-history-of-san-franciscos-mt-davidson-park/) |
| Twin Peaks, Bernal Hill, Glen Canyon, other Natural Areas | Coastal scrub and coastal prairie grassland, purple needlegrass, rock outcrops | Twin Peaks holds some of the largest remaining coastal scrub and prairie in the city; 31 Natural Areas cover about 4% of SF | [SFRPD Twin Peaks](https://sfrecpark.org/DocumentCenter/View/8527/68TwinPeaks), [Bay Nature](https://baynature.org/article/san-francisco-natural-areas-program/) |
| Buena Vista Park | Coast live oak woodland (one of the last in SF) | | [SFRPD plan](https://www.sfrecpark.org/DocumentCenter/View/8534/615OakWoodlands) |
| Ocean Beach, Fort Funston, Lands End dunes | Coastal dune scrub: coyote brush (*Baccharis pilularis*), bush lupine, Chamisso lupine, poison oak; European beachgrass and iceplant over much of the dune front | Beachgrass was introduced in the late 1800s to stabilise sand; no Ocean Beach-specific document was found, so use the GGNRA description as a proxy. Ocean Beach itself is bare sand with beachgrass patches on the dune toe | [NPS dune scrub](https://www.nps.gov/prsf/learn/nature/coastal-dune-scrub-community.htm), [Point Reyes EA](https://www.nps.gov/pore/getinvolved/upload/planning_dunerestoration_project_ea_fonsi_150512.pdf) |
| Berkeley / Oakland hills | Eucalyptus (blue gum) and Monterey pine on ridges; before the 1900s plantations the hills were chaparral, grassland and riparian vegetation. Coast live oak and bay laurel in canyons: UNCONFIRMED (no source found) | Eucalyptus came in the early 1900s for lumber plantations that were abandoned and spread; eucalyptus carried most of the energy in the 1991 firestorm (NPS figure cited as 70% by an Oakland news outlet) | [Oakland North](https://oaklandnorth.net/?p=64041), [Berkeley News](https://newsarchive.berkeley.edu/news/media/releases/2000/08/29_fire.html) |
| Joaquin Miller Park (Oakland) | Second-growth redwood in the upper reaches (Big Trees trail, Sequoia Bayview trail), oak/bay below: UNCONFIRMED | About 500 acres, 800-1,500 ft elevation; mostly second and third growth after 19th-century logging | [Oakland Parks](https://oaklandparks.org/joaquin-miller-park), [Bay Area Older Adults](https://bayareaolderadults.org/parks/oakland/joaquin-miller-park) |
| Redwood Regional Park | Third-growth coast redwood | Original trees logged 1845-1860, second growth cut after 1906; today's redwoods are third-growth and many are over 100 years old. No height figure found: use the lidar CHM (typical value for 100-year East Bay redwood is 40 to 55 m: UNCONFIRMED) | [Wikipedia](https://en.wikipedia.org/wiki/Dr._Aurelia_Reinhardt_Redwood_Regional_Park) |

### Placing communities without hand data

- Use the CHM + NLCD/WorldCover (both in MAP_RESOURCES.md) for tree vs scrub vs grass, then assign a community by polygon, for example:
  - Presidio, GGP and Lone Mountain: Monterey cypress / pine / blue gum mix (Presidio about 42-50% blue gum).
  - Sutro, Mt Davidson, Berkeley and Oakland ridges: 90% blue gum with some pine.
  - Joaquin Miller upper slopes and Redwood Regional: redwood.
  - GGP Oak Woodlands, Buena Vista: coast live oak.
  - Twin Peaks, Bernal, Glen Canyon, Ocean Beach dunes: scrub (0.5-2 m) or grass.
- Distinguish blue gum from pine and cypress by tree shape: eucalyptus crowns in a CHM are taller (30-50 m) with a narrow open crown; cypress is shorter and wider; pine is in between (kit heights above). This is a heuristic (UNCONFIRMED).
- Redwood stands are the tallest, densest class: good for a "very tall, dark conical" kit when the CHM exceeds about 40 m inside an Oakland hills polygon.

## 7. Grass and ground colour by season

- Bay Area grassland is a non-native annual grassland (wild oat, brome, barley). It turns green with winter rain, peaks in spring, and goes golden-brown in summer and fall because of a roughly six-month dry season. Native perennial bunchgrasses (purple needlegrass, state grass) survive in patches, mostly on protected slopes such as Bernal Hill. Sources: [Bay Nature](https://baynature.org/article/grassland-heritage/), [Annual grasslands](https://en.wikipedia.org/wiki/Annual_grasslands).
- Seasonal model (colour values are UNCONFIRMED art choices):

| Months | Hill grass | Notes |
|---|---|---|
| Nov-Jan | Short, patchy green-brown, greening after first rains | |
| Feb-Apr | Lush bright green (peak) | wildflower accent possible on Twin Peaks |
| May | Green fading to straw at the tips | |
| Jun-Oct | Golden-tan, brown at the ends | the "golden hills" look; dry grass is the fire fuel |

- Urban lawns (GGP, Presidio lawns, Dolores) stay green, because they are irrigated. Use a separate flat green for managed turf and a seasonal curve only for unirrigated hills (Twin Peaks, Bernal, Presidio coastal bluffs, the Berkeley/Oakland hills, Marin Headlands in phase 3).
- Coastal scrub (coyote brush, lupine): dark green year-round, so stay dark. Dunes: pale sand, tan beachgrass.
- Evergreen woods (eucalyptus, cypress, pine, oak, redwood) are visually a dark constant against the seasonal grass.
- The baked NAIP imagery (June-July in the 4-band 2022 flights: acquisition date UNCONFIRMED) would show the dry state of the hills only; a winter variant needs a colour shift, not a second image set.

## 8. Recommended data pipeline

1. Bake street trees as per-tile instance arrays: `[x, z, kitId, height, crownW, trunkR, seed]`, using the inventory points, with kit from species string via the table in section 4 and height from the CHM where available.
2. Bake park-tree points from a CHM local-maxima pass, with community-polygon kit assignment. Cap density to match the render budget (instanced, impostor-LOD).
3. Ship a `kits.json` with the parameters above and a `season` uniform for deciduous colour, flower sprites and grass colour.
4. Attribute the inventories (PDDL for SF, CC0 for Oakland `4jcx-enxf`) in `ATTRIBUTION`.
5. Do not ship raw `svwc-9r23` rows. Its licence is unstated.

## 9. Open items

- Cited heights for street-tree species beyond those with a Wikipedia page are not verified. SelecTree (https://selectree.calpoly.edu) is the right source, but its pages are JavaScript-rendered and WebFetch could not read them. Try the Cal Poly SelecTree export or a browser session.
- Redwood Regional and Joaquin Miller canopy heights, coast live oak and bay laurel extent in the Berkeley/Oakland hills, and lidar acquisition months for the two projects are not confirmed.
- Whether DataSF `mapdbh` max values of 100 are real or placeholders is unconfirmed.
- Berkeley city trees (2013) count and licence are not confirmed.

## Fact-check

Independent check on 2026-10-26. Verdicts: confirmed, wrong, unverifiable.

1. SF inventory counts and top species. CONFIRMED. Live Socrata queries return 144,522 rows, 1,222 null species, London plane 8,941, Brisbane box 6,972, NZ Christmas tree 6,971, swamp myrtle 6,424, Victorian box 5,579, Eucalyptus (`like`) 2,304, Monterey cypress 1,694, Monterey pine 1,563. Source: https://data.sf.gov/resource/tkzw-k3nq.json
2. `mapdbh` text, medians, "many species have a placeholder max of 100". PARTLY WRONG. `mapdbh` is a text column (https://data.sf.gov/api/views/tkzw-k3nq.json) and the medians recompute exactly (cypress 28, pine 22, blue gum 25, London plane 10, swamp myrtle 3). But only 65 rows in the whole dataset have `mapdbh` = '100', and per-species maxima are not 100 (cypress 105, blue gum 106, London plane 125, swamp myrtle 100). The "placeholder max of 100 for many species" claim is not supported; some large values (100 to 125) may be errors, unconfirmed. "Many street trees are young" is supported by the medians (the most common value is 3 in).
3. Presidio forest. PARTLY WRONG. 75,000 trees on 306 acres, planting by the Army beginning 1886, and 1886-1910 about 100,000 trees are confirmed (https://wp.presidio.gov/wp-content/uploads/2023/07/Forestry-Program-Fact-Sheet-June-2023-Accessible.pdf, https://baynature.org/article/presidios-forest-resists-the-sands-of-time/). Corrections: 1883 was the date of Maj. Jones's plan, not of planting (planting began 1886); the fact sheet says five species make up 90 percent (cypress, pine, blue gum, blackwood acacia, redwood), so acacia is omitted from "the rest"; the 42% figure comes from NPS (https://www.nps.gov/goga/blogs/planting-with-a-purpose-eucalyptus-and-the-u-s-army.htm), described as eucalyptus generally, and Bay Nature says nearly half. Neither Presidio source gives a blue-gum-only percentage in the fact sheet.
4. Sutro and Mt Davidson. PARTLY CONFIRMED. Sutro: 61-acre UCSF reserve, 19 city acres, trees over 100 ft confirmed (https://en.wikipedia.org/wiki/Mount_Sutro); planting from 1886 confirmed by UCSF history (https://www.ucsf.edu/cgr/cgr-projects/mount-sutro-open-space-reserve and search results), though the Wikipedia page itself gives no year. Mt Davidson: 40.2-acre Natural Area with forest covering three-quarters is confirmed via the SFRPD plan snippet (https://sfrecpark.org/DocumentCenter/View/8521/62MountDavidson). The 29.96 acres of blue gum is UNCONFIRMED: the PDF was too large to fetch (over 10 MB) and no other source gave the figure (an advocacy site cites about 30 acres forested).
5. Grassland and Redwood Regional. CONFIRMED. Bay Nature describes introduced annual grasses, green in spring and golden brown in summer, with almost six months of drought (https://baynature.org/article/grassland-heritage/); "green in winter" is not stated there but is consistent with the seasonal text. Redwood Regional redwoods are third growth, logged 1845-1860 and again after 1906 (https://en.wikipedia.org/wiki/Dr._Aurelia_Reinhardt_Redwood_Regional_Park).
