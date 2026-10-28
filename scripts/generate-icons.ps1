param (
    [string]$RootDir = (Resolve-Path "$PSScriptRoot\..").Path
)

Add-Type -AssemblyName System.Drawing

$buildDir = Join-Path $RootDir "build"
$appxDir = Join-Path $buildDir "appx"

if (-not (Test-Path $buildDir)) { New-Item -ItemType Directory -Path $buildDir -Force | Out-Null }
if (-not (Test-Path $appxDir)) { New-Item -ItemType Directory -Path $appxDir -Force | Out-Null }

function Create-RoundedRectanglePath {
    param(
        [System.Drawing.RectangleF]$rect,
        [float]$radius
    )
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $diameter = $radius * 2.0

    $arc = [System.Drawing.RectangleF]::new($rect.X, $rect.Y, $diameter, $diameter)
    $path.AddArc($arc, 180, 90)

    $arc.X = $rect.Right - $diameter
    $path.AddArc($arc, 270, 90)

    $arc.Y = $rect.Bottom - $diameter
    $path.AddArc($arc, 0, 90)

    $arc.X = $rect.Left
    $path.AddArc($arc, 90, 90)

    $path.CloseFigure()
    return $path
}

function Render-WinAtmoIcon {
    param (
        [int]$size
    )

    $bmp = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $scale = [float]($size / 512.0)

    # 1. Background Squircle
    $pad = [float](24.0 * $scale)
    $rect = [System.Drawing.RectangleF]::new($pad, $pad, [float]($size - ($pad * 2)), [float]($size - ($pad * 2)))
    $radius = [float](100.0 * $scale)
    $bgPath = Create-RoundedRectanglePath -rect $rect -radius $radius

    # Subtle drop shadow behind tile
    $shadowRect = [System.Drawing.RectangleF]::new($pad, [float]($pad + (6.0 * $scale)), [float]($size - ($pad * 2)), [float]($size - ($pad * 2)))
    $shadowPath = Create-RoundedRectanglePath -rect $shadowRect -radius $radius
    $shadowBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(60, 0, 0, 0))
    $g.FillPath($shadowBrush, $shadowPath)
    $shadowBrush.Dispose()
    $shadowPath.Dispose()

    # Gradient: Navy (#0f172a) -> Deep Sky Blue (#0284c7) -> Cyan (#06b6d4)
    $pt1 = [System.Drawing.PointF]::new($pad, $pad)
    $pt2 = [System.Drawing.PointF]::new([float]($size - $pad), [float]($size - $pad))
    $gradBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        $pt1,
        $pt2,
        [System.Drawing.Color]::FromArgb(255, 15, 23, 42),
        [System.Drawing.Color]::FromArgb(255, 6, 182, 212)
    )
    $cb = [System.Drawing.Drawing2D.ColorBlend]::new()
    $cb.Colors = @(
        [System.Drawing.Color]::FromArgb(255, 15, 23, 42),
        [System.Drawing.Color]::FromArgb(255, 2, 132, 199),
        [System.Drawing.Color]::FromArgb(255, 6, 182, 212)
    )
    $cb.Positions = @(0.0, 0.45, 1.0)
    $gradBrush.InterpolationColors = $cb
    $g.FillPath($gradBrush, $bgPath)

    # Subtle inner border
    $borderPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(70, 255, 255, 255), [float][Math]::Max(1.0, 3.0 * $scale))
    $g.DrawPath($borderPen, $bgPath)
    $borderPen.Dispose()
    $gradBrush.Dispose()
    $bgPath.Dispose()

    # 2. Golden Sun
    $sunCenter = [System.Drawing.PointF]::new([float](340.0 * $scale), [float](180.0 * $scale))
    $sunRadius = [float](66.0 * $scale)
    $sunRect = [System.Drawing.RectangleF]::new([float]($sunCenter.X - $sunRadius), [float]($sunCenter.Y - $sunRadius), [float]($sunRadius * 2), [float]($sunRadius * 2))
    $sunBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        $sunRect,
        [System.Drawing.Color]::FromArgb(255, 254, 240, 138),
        [System.Drawing.Color]::FromArgb(255, 245, 158, 11),
        45.0
    )
    $g.FillEllipse($sunBrush, $sunRect)
    $sunBrush.Dispose()

    # Sun Rays
    $rayPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(190, 251, 191, 36), [float][Math]::Max(1.5, 6.0 * $scale))
    $rayPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $rayPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($rayPen, [float](340.0 * $scale), [float](88.0 * $scale), [float](340.0 * $scale), [float](70.0 * $scale))
    $g.DrawLine($rayPen, [float](405.0 * $scale), [float](115.0 * $scale), [float](418.0 * $scale), [float](102.0 * $scale))
    $g.DrawLine($rayPen, [float](432.0 * $scale), [float](180.0 * $scale), [float](450.0 * $scale), [float](180.0 * $scale))
    $g.DrawLine($rayPen, [float](405.0 * $scale), [float](245.0 * $scale), [float](418.0 * $scale), [float](258.0 * $scale))
    $rayPen.Dispose()

    # 3. Soft Weather Cloud
    $cloudPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
    # Circle left
    $cloudPath.AddEllipse([System.Drawing.RectangleF]::new([float](135.0 * $scale), [float](240.0 * $scale), [float](95.0 * $scale), [float](90.0 * $scale)))
    # Circle top center
    $cloudPath.AddEllipse([System.Drawing.RectangleF]::new([float](190.0 * $scale), [float](175.0 * $scale), [float](125.0 * $scale), [float](120.0 * $scale)))
    # Circle top right
    $cloudPath.AddEllipse([System.Drawing.RectangleF]::new([float](275.0 * $scale), [float](205.0 * $scale), [float](95.0 * $scale), [float](90.0 * $scale)))
    # Cloud base pill
    $cloudPath.AddRectangle([System.Drawing.RectangleF]::new([float](175.0 * $scale), [float](255.0 * $scale), [float](160.0 * $scale), [float](75.0 * $scale)))

    # Cloud shadow
    $cShadowBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(40, 0, 0, 0))
    $g.TranslateTransform(0, [float](5.0 * $scale))
    $g.FillPath($cShadowBrush, $cloudPath)
    $g.TranslateTransform(0, [float](-5.0 * $scale))
    $cShadowBrush.Dispose()

    $cloudGrad = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        [System.Drawing.PointF]::new(0, [float](180.0 * $scale)),
        [System.Drawing.PointF]::new(0, [float](330.0 * $scale)),
        [System.Drawing.Color]::FromArgb(255, 255, 255, 255),
        [System.Drawing.Color]::FromArgb(255, 226, 232, 240)
    )
    $g.FillPath($cloudGrad, $cloudPath)
    $cloudGrad.Dispose()
    $cloudPath.Dispose()

    # 4. Stylized Atmospheric Curve / Chart Line
    $curvePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 56, 189, 248), [float][Math]::Max(2.0, 14.0 * $scale))
    $curvePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $curvePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    
    $pts = @(
        [System.Drawing.PointF]::new([float](80.0 * $scale), [float](395.0 * $scale)),
        [System.Drawing.PointF]::new([float](150.0 * $scale), [float](415.0 * $scale)),
        [System.Drawing.PointF]::new([float](225.0 * $scale), [float](375.0 * $scale)),
        [System.Drawing.PointF]::new([float](300.0 * $scale), [float](395.0 * $scale)),
        [System.Drawing.PointF]::new([float](380.0 * $scale), [float](360.0 * $scale)),
        [System.Drawing.PointF]::new([float](440.0 * $scale), [float](350.0 * $scale))
    )
    $g.DrawCurve($curvePen, $pts, 0.45)
    $curvePen.Dispose()

    # 5. Sensor Ping Beacon
    $beaconCenter = [System.Drawing.PointF]::new([float](380.0 * $scale), [float](360.0 * $scale))
    # Outer ring
    $ringRadius = [float](15.0 * $scale)
    $ringPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(180, 255, 255, 255), [float][Math]::Max(1.0, 3.0 * $scale))
    $g.DrawEllipse($ringPen, [float]($beaconCenter.X - $ringRadius), [float]($beaconCenter.Y - $ringRadius), [float]($ringRadius * 2), [float]($ringRadius * 2))
    $ringPen.Dispose()

    # Inner Dot
    $dotRadius = [float](7.5 * $scale)
    $dotBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    $g.FillEllipse($dotBrush, [float]($beaconCenter.X - $dotRadius), [float]($beaconCenter.Y - $dotRadius), [float]($dotRadius * 2), [float]($dotRadius * 2))
    $dotBrush.Dispose()

    $g.Dispose()
    return $bmp
}

function Render-WideLogo {
    param (
        [int]$width = 310,
        [int]$height = 150
    )

    $bmp = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    # Left tile icon: 130x130
    $icon130 = Render-WinAtmoIcon -size 130
    $g.DrawImage($icon130, 10, 10, 130, 130)
    $icon130.Dispose()

    # Text: winAtmo
    $titleFont = [System.Drawing.Font]::new("Segoe UI", 26, [System.Drawing.FontStyle]::Bold)
    $titleBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $g.DrawString("winAtmo", $titleFont, $titleBrush, 148, 38)
    $titleFont.Dispose()
    $titleBrush.Dispose()

    # Subtitle: Weather Station
    $subFont = [System.Drawing.Font]::new("Segoe UI", 12, [System.Drawing.FontStyle]::Regular)
    $subBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(200, 224, 242, 254))
    $g.DrawString("Weather Station", $subFont, $subBrush, 150, 78)
    $subFont.Dispose()
    $subBrush.Dispose()

    $g.Dispose()
    return $bmp
}

function Write-IcoFile {
    param (
        [string]$outputPath,
        [System.Drawing.Bitmap[]]$bitmaps
    )

    $msList = [System.Collections.Generic.List[System.IO.MemoryStream]]::new()
    foreach ($b in $bitmaps) {
        $ms = [System.IO.MemoryStream]::new()
        $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $msList.Add($ms)
    }

    $count = $bitmaps.Count
    $headerSize = 6
    $dirEntrySize = 16
    $dataOffset = $headerSize + ($dirEntrySize * $count)

    $fs = [System.IO.File]::Create($outputPath)
    $bw = [System.IO.BinaryWriter]::new($fs)

    # Header
    $bw.Write([uint16]0) # Reserved
    $bw.Write([uint16]1) # Type (1 = ICO)
    $bw.Write([uint16]$count) # Count

    # Directory Entries
    for ($i = 0; $i -lt $count; $i++) {
        $b = $bitmaps[$i]
        $ms = $msList[$i]
        $w = if ($b.Width -ge 256) { [byte]0 } else { [byte]$b.Width }
        $h = if ($b.Height -ge 256) { [byte]0 } else { [byte]$b.Height }

        $bw.Write([byte]$w)
        $bw.Write([byte]$h)
        $bw.Write([byte]0)   # Color count
        $bw.Write([byte]0)   # Reserved
        $bw.Write([uint16]1) # Color planes
        $bw.Write([uint16]32)# Bits per pixel
        $bw.Write([uint32]$ms.Length) # Size of image data
        $bw.Write([uint32]$dataOffset) # Offset

        $dataOffset += $ms.Length
    }

    # Image byte data
    for ($i = 0; $i -lt $count; $i++) {
        $ms = $msList[$i]
        $bytes = $ms.ToArray()
        $bw.Write($bytes, 0, $bytes.Length)
        $ms.Dispose()
    }

    $bw.Flush()
    $bw.Close()
    $fs.Close()
}

Write-Host "Rendering Master Icon (512x512)..."
$icon512 = Render-WinAtmoIcon -size 512
$icon512.Save((Join-Path $buildDir "icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)

Write-Host "Rendering Store Listing App Tile (300x300)..."
$tile300 = Render-WinAtmoIcon -size 300
$tile300.Save((Join-Path $buildDir "StoreTile300x300.png"), [System.Drawing.Imaging.ImageFormat]::Png)

Write-Host "Rendering Windows Store Assets in build/appx/..."
$storeLogo = Render-WinAtmoIcon -size 50
$storeLogo.Save((Join-Path $appxDir "StoreLogo.png"), [System.Drawing.Imaging.ImageFormat]::Png)

$square44 = Render-WinAtmoIcon -size 44
$square44.Save((Join-Path $appxDir "Square44x44Logo.png"), [System.Drawing.Imaging.ImageFormat]::Png)

$square150 = Render-WinAtmoIcon -size 150
$square150.Save((Join-Path $appxDir "Square150x150Logo.png"), [System.Drawing.Imaging.ImageFormat]::Png)

$wide = Render-WideLogo -width 310 -height 150
$wide.Save((Join-Path $appxDir "Wide310x150Logo.png"), [System.Drawing.Imaging.ImageFormat]::Png)

Write-Host "Rendering Multi-Resolution icon.ico..."
$icon256 = Render-WinAtmoIcon -size 256
$icon48 = Render-WinAtmoIcon -size 48
$icon32 = Render-WinAtmoIcon -size 32
$icon16 = Render-WinAtmoIcon -size 16
Write-IcoFile -outputPath (Join-Path $buildDir "icon.ico") -bitmaps @($icon256, $icon48, $icon32, $icon16)

$icon512.Dispose()
$tile300.Dispose()
$storeLogo.Dispose()
$square44.Dispose()
$square150.Dispose()
$wide.Dispose()
$icon256.Dispose()
$icon48.Dispose()
$icon32.Dispose()
$icon16.Dispose()

Write-Host "All Microsoft Store & Windows icon assets generated successfully!" -ForegroundColor Green
