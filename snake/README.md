# Connectome Snake

This experiment gives the repository's full 139,255-neuron connectome one irreversible choice at each Snake move: turn left, continue forward, or turn right.

It is intentionally not a competent Snake bot. There is no pathfinding, collision veto, scripted fallback, reward optimization, or weight update. If the selected readout points into a wall, the snake dies.

## Run it

From the repository root, serve the files over HTTP:

    python -m http.server 8000

Then open:

    http://localhost:8000/snake/

Loading and grouping the connectome can take several seconds. Modern browser support for Web Workers and DecompressionStream is required.

## Experimental contract

| Stage | Fixed mapping |
| --- | --- |
| Food bearing | Relative left, forward, and right visual cohorts from VIS_R1R6 |
| Food presence | OLF_ORN_FOOD cohort, scaled by proximity |
| Obstacles | Three short rays feed deterministic OLF_ORN_DANGER and MECH_BRISTLE cohorts |
| Baseline | Low tonic CX_EPG input supplies arousal because the LIF model has no spontaneous noise |
| Action readout | Equal-sized fixed cohorts sampled across GNG_DESC, CX_PFN, CX_HDELTA, and CX_FC |
| Eat event | One transient GUS_GRN_SWEET pulse |
| Collision | One transient OLF_ORN_DANGER and MECH_BRISTLE pulse |

The simulation worker first reorders neurons by functional group. Cohorts are then selected deterministically from those group ranges. They do not change between games. Every decision accumulates actual spikes in the three readout cohorts and selects the largest normalized rate. Exact ties continue forward.

The action labels are a preregistered experimental readout, not a claim that the source data contains anatomically validated left-turn, forward, and right-turn motor labels. Several motor classifications in this repository are empty, so descending and central-complex groups provide the observable readout.

## Controls

- Pause Game stops board decisions while the connectome keeps ticking.
- Step asks the brain for exactly one move.
- New Game resets only the board, retaining neural state.
- Reset Brain clears neural voltages and applies a fresh warm-up.
- Ticks per move changes the observation window, not the controller.

The seed field makes food placement repeatable. It does not seed or alter the neural dynamics, which are deterministic in the included simulator.
