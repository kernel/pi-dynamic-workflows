# Hypeship fork

Kernel keeps `main` synchronized with `QuintinShaw/pi-dynamic-workflows` and
maintains Hypeship-specific integration patches in this fork.

The patches add a headless projection and control seam for Hypeship's agent
runner. Hypeship pins an immutable commit from this repository when building its
VM image.
