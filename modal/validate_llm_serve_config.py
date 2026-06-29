"""
Fast, local validator for modal/llm_serve.py.

Because the real failure (container crash on Modal) is expensive and slow to
reproduce, this script checks the SGLang launch configuration against the known
hardware and runtime requirements of the selected model. It is intended as the
first, deterministic step of the feedback loop: run it before every deploy.
"""

import ast
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LLM_SERVE = REPO_ROOT / "modal" / "llm_serve.py"

# Known model requirements. These are conservative, grounded in the Qwen3 model
# card and the Bud orchestrator spec (docs/superpowers/specs/2026-06-18-orchestrator-agent-design.md).
MODEL_REQUIREMENTS = {
    "Qwen/Qwen3-235B-A22B": {
        "min_sglang_version": (0, 4, 6, "post1"),
        "min_gpus": {
            # GPU family -> (min_count, min_vram_gb_per_gpu)
            "H100": (8, 80),
            "A100-80GB": (8, 80),
            "H200": (4, 140),
        },
        "needs_reasoning_parser": True,
        "tool_call_parser": "qwen",
        "max_model_len_default": 32768,
    },
    "Qwen/Qwen3-32B": {
        "min_sglang_version": (0, 4, 6),
        "min_gpus": {
            "H100": (2, 80),
            "H200": (1, 140),
            "A100-80GB": (2, 80),
        },
        "needs_reasoning_parser": False,
        "tool_call_parser": None,
        "max_model_len_default": 32768,
    },
}


def extract_constants_and_cmd(src: str):
    """Parse the top-level assignments and the `cmd` list from startup."""
    tree = ast.parse(src)
    constants = {}

    # First pass: collect top-level assignments (literals and simple expressions).
    assignments = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    assignments.append((target.id, node.value))

    # Resolve literals first, then simple dependent expressions.
    for name, value in assignments:
        try:
            constants[name] = ast.literal_eval(value)
        except (ValueError, SyntaxError):
            pass

    changed = True
    while changed:
        changed = False
        for name, value in assignments:
            if name in constants:
                continue
            try:
                constants[name] = _eval_simple_expr(value, constants)
                changed = True
            except ValueError:
                pass

    # Second pass: find `cmd = [...]` and resolve references to constants.
    cmd = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "cmd":
                    cmd = _ast_list_to_strings(node.value, constants)

    return constants, cmd


def _eval_simple_expr(node, constants: dict):
    """Evaluate limited expressions in the cmd list: constants, names, str(x), int(x), a+b, a*b."""
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in constants:
            return constants[node.id]
        raise ValueError(f"Unknown name {node.id}")
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or len(node.args) != 1:
            raise ValueError("Unsupported call")
        arg_val = _eval_simple_expr(node.args[0], constants)
        if node.func.id == "str":
            return str(arg_val)
        if node.func.id == "int":
            return int(arg_val)
        raise ValueError(f"Unsupported function {node.func.id}")
    if isinstance(node, ast.BinOp):
        left = _eval_simple_expr(node.left, constants)
        right = _eval_simple_expr(node.right, constants)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Mult):
            return left * right
        raise ValueError(f"Unsupported binary operator {type(node.op).__name__}")
    raise ValueError(f"Unsupported expression {type(node).__name__}")


def _ast_list_to_strings(node, constants: dict):
    """Convert a list AST node into a list of strings, resolving constants."""
    if not isinstance(node, ast.List):
        return None
    out = []
    for elt in node.elts:
        try:
            val = _eval_simple_expr(elt, constants)
            out.append(str(val))
        except ValueError:
            out.append("<expr>")
    return out


def parse_gpu(gpu: str):
    """Parse a Modal GPU string like 'H100:8' or 'A100-80GB:4'."""
    m = re.match(r"^([A-Za-z0-9\-]+)(?::(\d+))?$", gpu)
    if not m:
        return None, 0
    family, count_str = m.groups()
    count = int(count_str) if count_str else 1
    return family, count


def parse_sgLang_version(image: str):
    """Extract the version tuple from an image tag like 'lmsysorg/sglang:v0.5.13.post1-cu129'."""
    m = re.search(r"sglang:v(\d+)\.(\d+)\.(\d+)(?:\.(post\d+))?(?:-|\b)", image)
    if not m:
        return None
    major, minor, patch, post = m.groups()
    return (int(major), int(minor), int(patch), post or "")


def version_gte(v, required):
    """Compare version tuples, handling the optional 'postN' suffix."""
    if v is None:
        return False
    # Pad both to 4 elements.
    def key(t):
        major, minor, patch = t[0], t[1], t[2]
        post = t[3] if len(t) > 3 else ""
        post_num = int(re.search(r"\d+", post).group()) if post and re.search(r"\d+", post) else 0
        return (major, minor, patch, post_num)

    return key(v) >= key(required)


def validate(llm_serve_path: Path = DEFAULT_LLM_SERVE):
    if not llm_serve_path.exists():
        print(f"[FAIL] {llm_serve_path} not found")
        return 1

    src = llm_serve_path.read_text(encoding="utf-8")
    constants, cmd = extract_constants_and_cmd(src)

    model_name = constants.get("MODEL_NAME")
    gpu = constants.get("GPU")
    image = None

    # Find the image definition by regex (the builder chain is hard to parse in AST).
    image_match = re.search(r'from_registry\("([^"]+sglang[^"]*)"\)', src)
    if image_match:
        image = image_match.group(1)

    print(f"Detected MODEL_NAME={model_name}")
    print(f"Detected GPU={gpu}")
    print(f"Detected image={image}")
    if cmd:
        print(f"Detected cmd={cmd}")
    else:
        print("Could not extract cmd list")

    errors = []

    if model_name not in MODEL_REQUIREMENTS:
        print(f"[WARN] No built-in requirement table for {model_name}; skipping model-specific checks.")
        return 0

    req = MODEL_REQUIREMENTS[model_name]

    # 1. SGLang version.
    sglang_version = parse_sgLang_version(image) if image else None
    if not sglang_version:
        errors.append(f"Could not parse SGLang version from image: {image}")
    elif not version_gte(sglang_version, req["min_sglang_version"]):
        errors.append(
            f"SGLang image {image} (version {sglang_version}) is too old; "
            f"need >= {req['min_sglang_version']} for {model_name}."
        )

    # 2. GPU count.
    family, count = parse_gpu(gpu) if gpu else (None, 0)
    if not family:
        errors.append(f"Could not parse GPU setting: {gpu}")
    elif family not in req["min_gpus"]:
        errors.append(
            f"GPU family '{family}' is not in the supported list for {model_name}: "
            f"{list(req['min_gpus'].keys())}."
        )
    else:
        min_count, min_vram = req["min_gpus"][family]
        if count < min_count:
            errors.append(
                f"{model_name} needs at least {min_count}x {family} ({min_vram}GB), "
                f"but GPU is set to {gpu}."
            )

    # 3. Tensor parallelism must match GPU count for a single-node SGLang launch.
    if cmd:
        try:
            tp_idx = cmd.index("--tp")
            tp_size = int(cmd[tp_idx + 1])
            if family and count and tp_size != count:
                errors.append(
                    f"--tp {tp_size} does not match GPU count {count} ({gpu}). "
                    "SGLang tensor-parallel size should equal the number of GPUs in the container."
                )
        except (ValueError, IndexError):
            errors.append("Could not parse --tp value from launch command.")

    # 4. Reasoning parser for Qwen3 MoE.
    if req["needs_reasoning_parser"]:
        if not cmd or "--reasoning-parser" not in cmd:
            errors.append(
                f"{model_name} requires --reasoning-parser qwen3 in the SGLang command."
            )
        else:
            rp_idx = cmd.index("--reasoning-parser")
            if rp_idx + 1 >= len(cmd) or cmd[rp_idx + 1] != "qwen3":
                errors.append("--reasoning-parser must be set to 'qwen3' for Qwen3-235B-A22B.")

    # 4b. Tool-call parser so Qwen3 outputs are converted to OpenAI tool_calls.
    expected_tcp = req.get("tool_call_parser")
    if expected_tcp:
        if not cmd or "--tool-call-parser" not in cmd:
            errors.append(
                f"{model_name} requires --tool-call-parser {expected_tcp} in the SGLang command."
            )
        else:
            tcp_idx = cmd.index("--tool-call-parser")
            if tcp_idx + 1 >= len(cmd) or cmd[tcp_idx + 1] != expected_tcp:
                errors.append(
                    f"--tool-call-parser must be set to '{expected_tcp}' for {model_name}."
                )

    # 5. Context-length guard to avoid OOM from unbounded context.
    # SGLang v0.5.13.post1 uses --context-length; --max-model-len is rejected.
    if cmd and "--max-model-len" in cmd:
        errors.append(
            "--max-model-len is not a valid SGLang v0.5.13 argument; use --context-length instead."
        )
    elif cmd and "--context-length" in cmd:
        try:
            cl_idx = cmd.index("--context-length")
            cl = int(cmd[cl_idx + 1])
            if cl > req["max_model_len_default"]:
                errors.append(
                    f"--context-length {cl} exceeds the native {req['max_model_len_default']} "
                    "for this model. Use YaRN/JSON override if you really need longer context."
                )
        except (ValueError, IndexError):
            errors.append("Could not parse --context-length value.")
    else:
        # Not strictly a crash, but warn.
        print(f"[WARN] --context-length not set; SGLang will use the model default.")

    if errors:
        print("\n[FAIL] Configuration issues found:")
        for e in errors:
            print(f"  - {e}")
        return 1

    print("\n[OK] SGLang configuration looks consistent with the selected model.")
    return 0


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Validate modal/llm_serve.py SGLang config")
    parser.add_argument(
        "file",
        nargs="?",
        type=Path,
        default=DEFAULT_LLM_SERVE,
        help="Path to an llm_serve.py file to validate (default: modal/llm_serve.py)",
    )
    args = parser.parse_args()
    sys.exit(validate(args.file))
