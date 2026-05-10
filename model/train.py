"""Local YOLO training and export pipeline for Riftbound Scanner."""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
DATASET_DIR = BASE_DIR / "dataset"
RUNS_DIR = BASE_DIR / "runs"
PUBLIC_MODELS_DIR = BASE_DIR.parent / "public" / "models"
MODEL_NAME = "yolo11n-obb.pt"
EXPORT_NAME = "yolo11n-obb-riftbound"

TRAINING_PROFILES = {
    "balanced": {
        "epochs": 12,
        "batch": 8,
        "workers": max(1, (os.cpu_count() or 4) // 2),
        "extra": {
            "amp": True,
            "cos_lr": True,
            "patience": 30,
            "close_mosaic": 10,
            "hsv_v": 0.6,
            "mixup": 0.2,
            "degrees": 15,
            "optimizer": "AdamW",
        },
    },
    "accuracy": {
        "epochs": 20,
        "batch": 16,
        "workers": max(2, (os.cpu_count() or 4) // 2),
        "extra": {
            "amp": True,
            "cos_lr": True,
            "patience": 60,
            "close_mosaic": 15,
            "hsv_v": 0.7,
            "mixup": 0.25,
            "degrees": 20,
            "optimizer": "AdamW",
        },
    },
}

BASE_TRAIN_KWARGS = {
    "hsv_v": 0.6,
    "mixup": 0.2,
    "degrees": 15,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train and export the local Riftbound detector.")
    parser.add_argument("--dataset-dir", default=str(DATASET_DIR), help="Path to the YOLO dataset directory.")
    parser.add_argument("--runs-dir", default=str(RUNS_DIR), help="Path where training runs should be written.")
    parser.add_argument(
        "--preset",
        choices=["custom", "balanced", "accuracy"],
        default="custom",
        help="Training preset to apply before launching YOLO.",
    )
    parser.add_argument("--epochs", type=int, default=5, help="Number of training epochs.")
    parser.add_argument("--imgsz", type=int, default=640, help="Training and export image size.")
    parser.add_argument("--batch", type=int, default=8, help="Training batch size.")
    parser.add_argument("--fraction", type=float, default=1.0, help="Fraction of the dataset to use for training and validation.")
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) // 2), help="Number of dataloader workers.")
    parser.add_argument("--device", default="auto", help="Training device: auto, cpu, 0, 1, ...")
    parser.add_argument("--keep-runs", action="store_true", help="Keep any existing runs/ directory instead of deleting it first.")
    parser.add_argument("--export-only", action="store_true", help="Skip training and only export from an existing best.pt checkpoint.")
    return parser.parse_args()


def apply_training_profile(args: argparse.Namespace) -> dict:
    if args.preset == "custom":
        return {}

    profile = TRAINING_PROFILES[args.preset]
    args.epochs = profile["epochs"]
    args.batch = profile["batch"]
    args.workers = profile["workers"]
    return profile["extra"]


def resolve_device(device: str) -> str | int:
    if device != "auto":
        return int(device) if device.isdigit() else device

    try:
        import torch

        return 0 if torch.cuda.is_available() else "cpu"
    except ImportError:
        return "cpu"


def ensure_dataset(dataset_dir: Path) -> Path:
    train_images = dataset_dir / "train" / "images"
    train_labels = dataset_dir / "train" / "labels"
    val_images = dataset_dir / "val" / "images"
    val_labels = dataset_dir / "val" / "labels"

    required_paths = [train_images, train_labels, val_images, val_labels]
    missing_paths = [path for path in required_paths if not path.exists()]
    if missing_paths:
        print("ERROR: The generated dataset is missing.")
        for path in missing_paths:
            print(f"  Missing: {path}")
        print("Run `python model/data_creator.py` first to build model/dataset/.")
        raise SystemExit(1)

    dataset_dir.mkdir(parents=True, exist_ok=True)
    yaml_path = dataset_dir / "data.yaml"
    dataset_root = dataset_dir.resolve().as_posix()
    yaml_path.write_text(
        f"path: {dataset_root}\n"
        "train: train/images\n"
        "val: val/images\n\n"
        "nc: 1\n"
        "names: ['card']\n",
        encoding="utf-8",
    )
    return yaml_path


def train_model(
    dataset_yaml: Path,
    runs_dir: Path,
    epochs: int,
    imgsz: int,
    batch: int,
    fraction: float,
    workers: int,
    device: str | int,
    keep_runs: bool,
    extra_train_kwargs: dict,
) -> Path:
    from ultralytics import YOLO

    if runs_dir.exists() and not keep_runs:
        shutil.rmtree(runs_dir)
    runs_dir.mkdir(parents=True, exist_ok=True)

    print(f"Training {MODEL_NAME} on device={device}...")
    if extra_train_kwargs:
        print(f"Training preset extras: {extra_train_kwargs}")
    model = YOLO(MODEL_NAME)
    train_kwargs = {**BASE_TRAIN_KWARGS, **extra_train_kwargs}
    model.train(
        data=str(dataset_yaml),
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        workers=workers,
        device=device,
        task="obb",
        fraction=fraction,
        project=str(runs_dir),
        name="train",
        exist_ok=True,
        **train_kwargs,
    )

    best_path = runs_dir / "train" / "weights" / "best.pt"
    if not best_path.exists():
        raise FileNotFoundError(f"Training completed, but no checkpoint was written at {best_path}.")

    print(f"Training complete: {best_path}")
    return best_path


def export_onnx(best_path: Path, imgsz: int) -> Path:
    from ultralytics import YOLO

    print("Exporting ONNX model...")
    YOLO(str(best_path)).export(
        format="onnx",
        imgsz=imgsz,
        opset=12,
        simplify=True,
        dynamic=False,
        device="cpu",
    )

    onnx_path = best_path.with_suffix(".onnx")
    if not onnx_path.exists():
        raise FileNotFoundError(f"ONNX export failed: {onnx_path} was not created.")

    return onnx_path


def quantize_onnx(onnx_path: Path) -> Path:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    quantized_path = onnx_path.with_name("best_quantized.onnx")
    print("Quantizing ONNX model to int8...")
    quantize_dynamic(str(onnx_path), str(quantized_path), weight_type=QuantType.QUInt8)

    if not quantized_path.exists():
        raise FileNotFoundError(f"Quantization failed: {quantized_path} was not created.")

    return quantized_path


def publish_models(onnx_path: Path, quantized_path: Path | None) -> None:
    if PUBLIC_MODELS_DIR.exists():
        shutil.rmtree(PUBLIC_MODELS_DIR)

    PUBLIC_MODELS_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(onnx_path, PUBLIC_MODELS_DIR / f"{EXPORT_NAME}.onnx")

    if quantized_path and quantized_path.exists():
        shutil.copy2(quantized_path, PUBLIC_MODELS_DIR / f"{EXPORT_NAME}-q8.onnx")

    print(f"Published models to {PUBLIC_MODELS_DIR}")


def main() -> None:
    args = parse_args()
    extra_train_kwargs = apply_training_profile(args)

    dataset_dir = Path(args.dataset_dir)
    runs_dir = Path(args.runs_dir)
    device = resolve_device(args.device)

    if args.export_only:
        best_path = runs_dir / "train" / "weights" / "best.pt"
        if not best_path.exists():
            raise FileNotFoundError(f"Cannot export because {best_path} does not exist. Run training first.")
    else:
        dataset_yaml = ensure_dataset(dataset_dir)
        best_path = train_model(
            dataset_yaml=dataset_yaml,
            runs_dir=runs_dir,
            epochs=args.epochs,
            imgsz=args.imgsz,
            batch=args.batch,
            fraction=args.fraction,
            workers=args.workers,
            device=device,
            keep_runs=args.keep_runs,
            extra_train_kwargs=extra_train_kwargs,
        )

    onnx_path = export_onnx(best_path, args.imgsz)
    quantized_path = quantize_onnx(onnx_path)
    publish_models(onnx_path, quantized_path)

    print("Done. The app should now load the local detector from public/models/.")


if __name__ == "__main__":
    main()
