# User guide

Start the viewer as described in the [README](../README.md) and open http://127.0.0.1:5173/.

## The screen

| Area | What it holds |
|---|---|
| **Top bar** | Switch between **2D** and **3D**, and **Save PNG** of the current view |
| **Toolbar** | Options of the current view |
| **View** | The sensor, with the charge colour scale beside it |
| **Playback bar** | Play, Restart, and the Particle and Charge sliders |
| **Side panel** | **Event**, **Show**, and collapsible **Event details**, **Track** and **About this view** |

## Choosing an event

In **Event**, pick a **File**, then use ◀ and ▶, type an event number, or press ⤨ for a random event. Below them you always see the event's total **Charge**, the number of **Pixels** shown, and **cotα · cotβ**.

Open **Event details** for the truth values and charge statistics, and **Track** for the surface, midplane and exit positions, the pixels they fall in, and the path length in silicon.

## Reading the charge

Pixels are coloured by **pixelAV simulated charge** in electrons, on a signed log scale:

- **Viridis** (purple to yellow) is positive charge.
- **Rose** is negative charge. It is real simulation output, and appears in the early time slices.
- The scale is fixed per event, so a colour keeps its meaning across time slices.

## The 2D view

A top view of all 48 × 192 pixels at true proportions, so each pixel is drawn four times wider than tall.

| Control | Action |
|---|---|
| **Full sensor / Zoom to track** | Frame the whole sensor, or the track and its charge |
| **µm / pixels** | Label the axes in µm, or in pixels counted from the sensor centre (x −24 to 24, y −96 to 96) |
| Mouse wheel | Zoom about the cursor |
| Drag | Move the map when zoomed in |
| Hover | Show the pixel's address, position and charge in the toolbar |

Axis values in **pixels** are distances from the centre. Pixel **addresses**, as in `px (17, 89)`, stay zero-based (x 0–47, y 0–191), matching the dataset.

## The 3D view

| Control | Action |
|---|---|
| **Full sensor / Zoom to track** | Frame the whole sensor, or the track and its charge |
| **Iso / Top / X–Z / Y–Z** | Set the camera direction |
| **Z** | Stretch the 100 µm thickness on screen (display only) |
| Drag | Rotate |
| Right-drag or Shift+drag | Move |
| Mouse wheel | Zoom |

The toolbar shows the current azimuth and elevation. Charge bars rise above the surface, with height proportional to positive charge; this height is not a z coordinate.

## Playback

- **Play** and **Restart** run the animation. **Loop** repeats it.
- **Particle** moves the particle along its track.
- **Charge** selects one of the 20 cumulative time slices.
- The **chain** between the two sliders links them:
  - **Closed** (default): they move together. The slices are spread over the particle's path through the silicon, and no charge is shown before impact.
  - **Open**: they move independently, and **Charge vs time** plays the slices alone.

The link is a way of showing the sequence, not a physical time axis: the particle crosses the sensor much faster than the charge is collected.

## Show

Only **Grid and central axes** is on when the viewer opens.

| Group | Tick | Draws |
|---|---|---|
| **Trajectory** | Outside the sensor | The path before it enters the silicon, and after a side exit |
| | Inside the sensor | The path through the silicon |
| **Crossing points** | Surface, Midplane, Exit | Where the track crosses z = 0, −50 and −100 µm, with the pixel |
| **Pixels** | Grid and central axes | Pixel boundaries and the x = 0, y = 0 axes |
| | Crossed by the track | A thin red border on the pixels the path passes through (geometric, not charge) |
| | Hide \|q\| ≤ N e⁻ | Hides pixels at or below this charge magnitude, for both signs |
| **3D scene** (3D only) | Charge bars | Bars above the charged pixels |
| | Midplane sheet | The plane at z = −50 µm |
| | Dimensions | Sensor sizes and first and last row and column |

The threshold changes only what is drawn. Totals, the colour scale and the data are unchanged, and hovering over a hidden pixel still shows its charge.

## Keyboard

Click the view first, or reach it with `Tab`.

| Key | 2D | 3D |
|---|---|---|
| `+` / `−` | Zoom | Zoom |
| Arrow keys | Move (when zoomed in) | Rotate |
| `0` | Full sensor | Full sensor |
| `Space` | Play or pause | Play or pause |

## Shareable links

The address bar keeps the current event and main options, so you can copy it to share a view.

| Parameter | Meaning |
|---|---|
| `file=test/part.0` | File |
| `event=42` | Event number |
| `view=3d` | Open in 3D |
| `units=px` | Pixel axes in 2D |
| `fit=track` | Zoom to the track in 2D |
| `renderer=2d` | Force the fallback renderer |

Example: `http://127.0.0.1:5173/?file=test/part.0&event=42&fit=track`
