// chroma-strip — remove pure-magenta #FF00FF backgrounds from PNGs.
//
// Algorithm ported verbatim from
// kit/ena-chat/tools/sticker-studio/src/pipeline.rs (chroma_key +
// finalize_from_bytes). HSV hue band around 300°, corner-connected
// flood fill so accidental magenta inside the silhouette survives,
// soft despill at the silhouette edge.

use anyhow::{Context, Result};
use clap::Parser;
use std::path::{Path, PathBuf};

const CHROMA_HUE_CENTER: f32 = 300.0;
const CHROMA_HUE_HARD_BAND: f32 = 35.0;
const CHROMA_HUE_SOFT_BAND: f32 = 60.0;
const CHROMA_SAT_HARD: f32 = 0.55;
const CHROMA_SAT_SOFT: f32 = 0.25;
const CHROMA_VAL_MIN: f32 = 0.40;

// Edge-band cleanup. Magenta antialiasing / JPEG-artefact pixels at
// the silhouette boundary often have saturation in the 0.15-0.55
// range — above the soft-despill threshold but below hard-kill —
// which leaves a faint magenta halo. We resolve this by:
//   1. dilating the killed mask by EDGE_DILATION_RADIUS pixels,
//   2. inside that band only, hard-killing any pixel whose hue is
//      within EDGE_KILL_HUE_BAND of pure magenta,
//   3. leaving everything outside the band completely untouched.
// The narrow hue band (20° vs the global 35°) means colours that
// merely sit in the same family — royal purple ~271°, fuchsia ~320°
// — are NOT caught even when they're at the silhouette edge. Only
// real magenta-tinged spill goes.
const EDGE_DILATION_RADIUS: u32 = 4;
const EDGE_KILL_HUE_BAND: f32 = 20.0;
const EDGE_KILL_SAT_MIN: f32 = 0.12;
const EDGE_KILL_VAL_MIN: f32 = 0.15;

#[derive(Parser, Debug)]
#[command(
    name = "chroma-strip",
    about = "Strip #FF00FF chroma background from PNGs into transparent alpha.",
    version
)]
struct Cli {
    /// Input PNG file, or directory when --batch is set.
    input: PathBuf,

    /// Output PNG path. Defaults to <input>.cutout.png next to the input.
    /// Ignored in --batch mode.
    output: Option<PathBuf>,

    /// Process every *.png in the input directory. Outputs go to
    /// <input>/cutout/<name>.png unless --out-dir is given.
    #[arg(long)]
    batch: bool,

    /// Override batch output directory.
    #[arg(long)]
    out_dir: Option<PathBuf>,

    /// Resize the longest edge to N pixels (preserves aspect ratio).
    /// When omitted, the image keeps its native resolution.
    #[arg(long)]
    resize: Option<u32>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    if cli.batch {
        run_batch(&cli)
    } else {
        let out = cli
            .output
            .clone()
            .unwrap_or_else(|| default_single_output(&cli.input));
        process_one(&cli.input, &out, cli.resize)?;
        println!("wrote {}", out.display());
        Ok(())
    }
}

fn default_single_output(input: &Path) -> PathBuf {
    let stem = input
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "image".into());
    let parent = input.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!("{stem}.cutout.png"))
}

fn run_batch(cli: &Cli) -> Result<()> {
    anyhow::ensure!(
        cli.input.is_dir(),
        "--batch expects a directory, got {}",
        cli.input.display()
    );

    let out_dir = cli
        .out_dir
        .clone()
        .unwrap_or_else(|| cli.input.join("cutout"));
    std::fs::create_dir_all(&out_dir)?;

    let mut count = 0usize;
    for entry in std::fs::read_dir(&cli.input)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_png = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("png"))
            .unwrap_or(false);
        if !is_png {
            continue;
        }
        let name = path.file_name().unwrap();
        let out = out_dir.join(name);
        process_one(&path, &out, cli.resize)
            .with_context(|| format!("processing {}", path.display()))?;
        println!("wrote {}", out.display());
        count += 1;
    }
    println!("done — {count} file(s) processed into {}", out_dir.display());
    Ok(())
}

fn process_one(input: &Path, output: &Path, resize: Option<u32>) -> Result<()> {
    let bytes = std::fs::read(input)
        .with_context(|| format!("read {}", input.display()))?;
    let img = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .context("guess format")?
        .decode()
        .context("decode")?;

    let img = match resize {
        Some(n) if n > 0 => img.resize(n, n, image::imageops::FilterType::Lanczos3),
        _ => img,
    };

    let mut rgba = img.to_rgba8();
    chroma_key(&mut rgba);

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    rgba.save(output)
        .with_context(|| format!("save {}", output.display()))?;
    Ok(())
}

fn rgb_to_hue_sat(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
    let rf = r as f32 / 255.0;
    let gf = g as f32 / 255.0;
    let bf = b as f32 / 255.0;
    let max = rf.max(gf).max(bf);
    let min = rf.min(gf).min(bf);
    let delta = max - min;
    let hue = if delta < 1e-6 {
        0.0
    } else if (max - rf).abs() < 1e-6 {
        60.0 * (((gf - bf) / delta).rem_euclid(6.0))
    } else if (max - gf).abs() < 1e-6 {
        60.0 * ((bf - rf) / delta + 2.0)
    } else {
        60.0 * ((rf - gf) / delta + 4.0)
    };
    let hue = if hue < 0.0 { hue + 360.0 } else { hue };
    let sat = if max < 1e-6 { 0.0 } else { delta / max };
    (hue, sat, max)
}

fn hue_distance(h1: f32, h2: f32) -> f32 {
    let d = (h1 - h2).abs();
    d.min(360.0 - d)
}

fn chroma_key(img: &mut image::RgbaImage) {
    let w = img.width();
    let h = img.height();
    if w == 0 || h == 0 {
        return;
    }

    let num_pixels = (w * h) as usize;
    let mut hsv_buffer = vec![(0.0f32, 0.0f32, 0.0f32); num_pixels];
    let mut hard_mask = vec![false; num_pixels];

    let raw_pixels = img.as_raw();
    for i in 0..num_pixels {
        let r = raw_pixels[i * 4];
        let g = raw_pixels[i * 4 + 1];
        let b = raw_pixels[i * 4 + 2];

        let (hue, sat, val) = rgb_to_hue_sat(r, g, b);
        hsv_buffer[i] = (hue, sat, val);

        if val >= CHROMA_VAL_MIN {
            let hue_d = hue_distance(hue, CHROMA_HUE_CENTER);
            if hue_d <= CHROMA_HUE_HARD_BAND && sat >= CHROMA_SAT_HARD {
                hard_mask[i] = true;
            }
        }
    }

    let mut killed = vec![false; num_pixels];
    let corners: [(u32, u32); 4] = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)];
    for &(cx, cy) in &corners {
        let start_idx = (cy * w + cx) as usize;
        if !hard_mask[start_idx] || killed[start_idx] {
            continue;
        }

        let mut stack: Vec<(u32, u32)> = Vec::with_capacity(1024);
        stack.push((cx, cy));
        killed[start_idx] = true;

        while let Some((x, y)) = stack.pop() {
            let neighbors = [
                (x.wrapping_sub(1), y),
                (x + 1, y),
                (x, y.wrapping_sub(1)),
                (x, y + 1),
            ];
            for &(nx, ny) in &neighbors {
                if nx < w && ny < h {
                    let n_idx = (ny * w + nx) as usize;
                    if hard_mask[n_idx] && !killed[n_idx] {
                        killed[n_idx] = true;
                        stack.push((nx, ny));
                    }
                }
            }
        }
    }

    // Build the "near the killed region" mask by dilating `killed`
    // EDGE_DILATION_RADIUS times. Used to limit the aggressive
    // edge-kill pass below to the boundary — internal pixels stay
    // untouched.
    let mut near_killed = killed.clone();
    if EDGE_DILATION_RADIUS > 0 {
        let w_us = w as usize;
        let mut next = near_killed.clone();
        for _ in 0..EDGE_DILATION_RADIUS {
            for y in 0..h {
                for x in 0..w {
                    let i = (y * w + x) as usize;
                    if near_killed[i] {
                        continue;
                    }
                    let hit = (x > 0 && near_killed[i - 1])
                        || (x + 1 < w && near_killed[i + 1])
                        || (y > 0 && near_killed[i - w_us])
                        || (y + 1 < h && near_killed[i + w_us]);
                    if hit {
                        next[i] = true;
                    }
                }
            }
            std::mem::swap(&mut near_killed, &mut next);
            next.copy_from_slice(&near_killed);
        }
    }

    for (i, px) in img.chunks_exact_mut(4).enumerate() {
        if killed[i] {
            px[0] = 0;
            px[1] = 0;
            px[2] = 0;
            px[3] = 0;
            continue;
        }

        let (hue, sat, val) = hsv_buffer[i];
        let hue_d = hue_distance(hue, CHROMA_HUE_CENTER);

        // Edge-band cleanup: aggressive kill of magenta-tinged AA
        // pixels at the silhouette boundary that the global hard
        // pass missed (saturation dipped into 0.12-0.55). Only
        // applies to pixels close to the killed region (within
        // EDGE_DILATION_RADIUS) and only for hues very close to
        // pure magenta — adjacent purples / fuchsias survive.
        if near_killed[i]
            && hue_d <= EDGE_KILL_HUE_BAND
            && sat >= EDGE_KILL_SAT_MIN
            && val >= EDGE_KILL_VAL_MIN
        {
            px[0] = 0;
            px[1] = 0;
            px[2] = 0;
            px[3] = 0;
            continue;
        }

        if val < CHROMA_VAL_MIN {
            continue;
        }
        if hue_d > CHROMA_HUE_SOFT_BAND {
            continue;
        }

        let hue_t = ((hue_d - CHROMA_HUE_HARD_BAND)
            / (CHROMA_HUE_SOFT_BAND - CHROMA_HUE_HARD_BAND))
            .clamp(0.0, 1.0);
        let sat_t = ((sat - CHROMA_SAT_SOFT) / (CHROMA_SAT_HARD - CHROMA_SAT_SOFT))
            .clamp(0.0, 1.0);
        let keep = hue_t.max(1.0 - sat_t);

        let g_val = px[1] as f32;
        let despill = 1.0 - keep;

        if (px[0] as f32) > g_val {
            px[0] = (px[0] as f32 * keep + g_val * despill) as u8;
        }
        if (px[2] as f32) > g_val {
            px[2] = (px[2] as f32 * keep + g_val * despill) as u8;
        }
        px[3] = ((px[3] as f32) * keep) as u8;
    }
}
