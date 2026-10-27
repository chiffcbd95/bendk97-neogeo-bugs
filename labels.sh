#!/bin/bash
# Usage: ./labels.sh owner/repo   (requires gh authenticated)
R="${1:?usage: ./labels.sh owner/repo}"
mk() { gh label create "$1" --color "$2" --description "$3" --repo "$R" --force; }
# Games
mk snowbros 1d76db "Snow Bros"
mk sotb 5319e7 "Shadow of the Beast"
mk kotr b60205 "Knights of the Round"
mk cosmogang 0e8a16 "Cosmo Gang the Video"
mk outrun d93f0b "OutRun"
mk sodan fbca04 "Sword of Sodan"
# Platforms
mk mame c5def5 "Seen on MAME"
mk fbneo c5def5 "Seen on FBNeo"
mk aes c5def5 "Real AES"
mk mvs c5def5 "Real MVS"
mk neocd c5def5 "Neo Geo CD"
mk mister c5def5 "MiSTer"
mk flashcart c5def5 "Flash cart"
# Status
mk needs-repro ededed "Needs reproduction"
mk confirmed 0e8a16 "Confirmed"
mk fixed 006b75 "Fixed, in next release"
mk blocker b60205 "Blocks gameplay or boot"
