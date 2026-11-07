# Chunk Stage (local companion)

The local half of [Chunk Stage](https://github.com/arpitjp/chunk-stage). It's installed automatically with Chunk Stage and has no settings of its own.

In Remote SSH, WSL and container windows, Chunk Stage runs on the remote machine, next to git, so every keypress has to cross the network before the selected lines light up. The companion runs on your machine, next to the editor: it paints the highlight the moment you press the shortcut and leaves the actual staging to Chunk Stage. In local windows it does nothing.
