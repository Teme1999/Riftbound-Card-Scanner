# Riftbound Card Scanner

Recognising physical Riftbound cards from a camera and adding them to a collection.

## Recognition

**Detector**:
The part of the scanner that finds where a card is in the frame and outlines it. It does not know which card it is.
_Avoid_: model (ambiguous), YOLO

**Matcher**:
The part of the scanner that decides which card is in the outline by comparing its artwork against references.
_Avoid_: model (ambiguous), recogniser

**Reference**:
One stored artwork fingerprint of a known card that the matcher compares a scan against.
_Avoid_: hash, exemplar, template

**Official reference**:
A reference that comes from the card database.

**Learned reference**:
A reference saved from one of the user's own scans of a card.
_Avoid_: user exemplar, personal reference

## Scan outcomes

**Candidate**:
The best match the scanner shows for a card it has not accepted.
_Avoid_: guess, unverified card

**Accepted**:
A scan the scanner confirmed by itself.
_Avoid_: verified, confirmed

**User-confirmed**:
A scan where the user picked the card themselves, from the candidates or by search.
_Avoid_: manual override, forced accept

**Choice strip**:
The picker over the live camera view that offers the top three candidates, plus search, for a card the scanner has not accepted.
_Avoid_: candidate picker, overlay picker

**Snap review**:
The dialog that opens after a Snap the scanner did not accept, letting the user pick from the candidates or search.
_Avoid_: manual review, confirm dialog

## Cards

**Print**:
One version of a card with its own printed code, such as the normal print or an alt-art (e.g. `SP4/005`). A card can have several prints.
_Avoid_: variant (when meaning a whole print), version

**Code**:
The exact identifier printed on a print, such as `SP4/005`.
_Avoid_: collector number, variant number

**Legend**:
A card of the legend type, named by its champion plus its title.

**Full name**:
The name the app shows and exports for a card: champion plus title for a legend (`Kai'Sa, Daughter of the Void`), name plus subtitle for a card that has one (`Kai'Sa, Rebel`), otherwise the printed name. Every print of a card shares one full name; only the code tells prints apart.
_Avoid_: display name, long name

**Printed name**:
The name text as it appears on the card itself, such as `Daughter of the Void` or `Kai'Sa`.
_Avoid_: title (when meaning any card's name), short name

**Custom card**:
A print the user adds because the official card gallery does not list it.
_Avoid_: missing card, user card

**Card database**:
Every print the app knows: those from the official card gallery plus custom cards.
_Avoid_: catalog, hash DB
