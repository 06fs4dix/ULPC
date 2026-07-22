# Demo

[Demo](https://06fs4dix.github.io/ULPC/viewer/)

> Compatible with the [Artgine](https://github.com/06fs4dix/Artgine-Project) engine.

> Language **[한국어](README-ko.md)**

# Modified Universal LPC Spritesheet Character Generator

This project is a fork of the [Universal-LPC-Spritesheet-Character-Generator](https://liberatedpixelcup.github.io/Universal-LPC-Spritesheet-Character-Generator), modified and enhanced to meet specific workflow requirements. For basic operations and historical context, please refer to the original repository.

## Installation & Getting Started

```bash
git clone --recursive https://github.com/06fs4dix/ULPC.git
cd ULPC
npm install
npm start
```

## 🛠 Key Changes

### 1. Simplified Storage & Naming Convention
The previous complex JSON mapping system has been replaced with an **intuitive folder and file naming convention**. By embedding metadata directly into the filename, we've eliminated the hassle of cross-referencing JSON data with physical image locations.

* **Naming Convention:**
    `[ProjectName]-[TopPart]-p[SubPart]...n-a[AnimationName]-z[Depth]-[PaletteColor]_[Size]_[Frame]_[Direction].png`
* **Advantages:**
    * Instantly identify image attributes just by looking at the filename.
    * The project name prefix makes it easy to integrate and manage assets alongside other resources.

### 2. Standardized Animation Frame Rules
We have standardized the frame specifications to fix the issues caused by the variable frame sizes and irregular rules in the original ULPC project.

* **Problem Solved:** Previously, irregular or empty frames (e.g., Idle 0-0-1 vs. Walk 1-2-3...) required tedious hardcoding during parsing.
* **The Fix:** By duplicating or removing specific frames, all animations now follow a consistent, predictable rule set.
* **Optimization:** The layout is built based on the maximum frame size to ensure compatibility. Animations with specific repetition patterns (e.g., `000111222`) can now be handled flexibly via animation speed adjustments in your code.

### 3. Modernized & Lightweight Viewer
The viewer UI has been overhauled to minimize external dependencies and align with modern web standards.

* **UI Framework:** Integrated and upgraded to **Bootstrap 5**.
* **Customization:** The viewer logic has been completely rewritten to support the new file formats and structural changes.

### 4. Enhanced JSON Data Structure
Extracted JSON files now directly include the file structure and selected palette information.

* **Self-Sufficiency:** Assets can be used immediately using only the extracted JSON data, without needing separate constant definitions.
* **Flexibility:** Included palette data allows for easier dynamic color swapping and processing at runtime.

## 🙏 Acknowledgments
We extend our deepest gratitude to all contributors who established the LPC (Liberated Pixel Cup) standards and created high-quality assets. This project exists thanks to your hard work and dedication to the community.

*This project respects the spirit of open source and adheres to the original creator's licensing regulations.*
