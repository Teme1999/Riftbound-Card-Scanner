# Training Asset Notices

The files in `model/textures/` and `model/distractors/` are helper assets used
to generate synthetic detector training scenes. They are source-tree training
aids only and are not shipped as runtime application assets or Windows installer
payloads.

## Textures

Many texture filenames match the Describable Textures Dataset naming scheme,
for example `banded_0033.jpg`, `blotchy_0101.jpg`, and `woven_0123.jpg`.

Best-effort source:

- Describable Textures Dataset, Visual Geometry Group, University of Oxford
- Project page: `https://www.robots.ox.ac.uk/~vgg/data/dtd/`
- Paper: "Describing Textures in the Wild", Cimpoi, Maji, Kokkinos, Mohamed,
  and Vedaldi, CVPR 2014

The DTD release is commonly mirrored by dataset hosts with inconsistent license
metadata. Treat these images as training-only research data unless redistribution
rights have been verified for your release context.

## Distractors

Some distractor filenames look like imported object/image IDs, while newer
files such as `hands1.png`, `keyboard1.png`, `monitor1.png`, and `mouse1.jpeg`
appear to be local helper photos or cutouts. Provenance for these files is not
fully documented in this repository.

Before redistributing source archives, training bundles, or any other release
artifact that includes these helper assets, verify the source and rights for each
distractor image or replace them with assets that have explicit redistribution
terms.
