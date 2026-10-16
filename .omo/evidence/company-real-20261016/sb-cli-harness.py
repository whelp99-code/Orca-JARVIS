"""Actual SB CLI entry point with ONLY its explicit simulated-NV test dependency.

Never install this launcher. It does not prove TPM readiness or production setup.
All company authority, provider, SQL, receipt and CLI logic comes from SB source.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

SOURCE = Path("/home/jm/orca/lanes/sb-freshness-provider-20261016-aff1ac92")
sys.path.insert(0, str(SOURCE))
os.umask(0o077)
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sb.company_approver_binding import binding_document
from sb.company_db_freshness import CompanyDbFreshnessProvider
from sb.company_memory_cli import main
from sb.company_memory_cli_config import load_company_config
from sb.company_processor_progress import local_checkpoint
from sb.effect_values import canonical_bytes
from sb.effect_write_values import model_object


def secure_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    path.chmod(0o600)


class SimulatedPersistentNv:
    """Independent scratch file model; explicitly NOT a production fallback."""
    def __init__(self, root: Path, database: Path) -> None:
        self.path = root / "TEST_ONLY_SIMULATED_NV.json"
        self.database = database

    def identity(self) -> str:
        return "sim-1"

    def public_name(self) -> bytes:
        return bytes.fromhex(json.loads(self.path.read_text())["name"])

    def read_value(self) -> bytes:
        # A second writer must be able to acquire the DB while the provider does I/O.
        with closing(sqlite3.connect(self.database, timeout=0)) as writer:
            writer.execute("BEGIN IMMEDIATE")
            writer.rollback()
        return bytes.fromhex(json.loads(self.path.read_text())["value"])

    def extend(self, raw: bytes) -> bytes:
        value = json.loads(self.path.read_text())
        updated = hashlib.sha256(bytes.fromhex(value["value"]) + raw).digest()
        value["value"] = updated.hex()
        value["extends"] += 1
        temporary = self.path.with_suffix(".tmp")
        secure_json(temporary, value)
        with temporary.open("rb") as file:
            os.fsync(file.fileno())
        os.replace(temporary, self.path)
        return updated


def setup(root: Path) -> None:
    from tests.test_company_db_human_integration import human_runtime
    from tests.test_company_candidate_handoff import CONTEXT, KEY, OWNER_KEY, PROCESSOR_KEY
    root.mkdir(mode=0o700)
    config_path, provider = human_runtime(root)
    config = load_company_config(config_path)
    assert config.handoff_policy is not None
    progress = Ed25519PrivateKey.generate()
    encoded = __import__("base64").urlsafe_b64encode(progress.public_key().public_bytes_raw()).rstrip(b"=").decode()
    value = json.loads(config_path.read_text())
    value["freshness_provider"] = {"schema_version": 2, "kind": "sb_company_db", "registry_id": provider.registry_id}
    value["trusted_keys"]["progress:TEST_ONLY"] = encoded
    value["key_scopes"]["progress:TEST_ONLY"] = {
        "operations": ["read_freshness", "reserve_progress", "finish_progress", "read_auto_report"],
        "source_systems": ["mail"],
    }
    secure_json(config_path, value)
    for name, key in (("handoff", KEY), ("owner", OWNER_KEY), ("processor", PROCESSOR_KEY), ("progress", progress)):
        (root / (name + ".pem")).write_bytes(key.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        (root / (name + ".pem")).chmod(0o600)
    secure_json(root / "TEST_ONLY_SIMULATED_NV.json", {
        "name": provider.anchor.public_name().hex(), "value": provider.anchor.read_value().hex(),
        "extends": provider.anchor.extend_count,
    })
    secure_json(root / "provider.json", {
        "database": str(provider.database), "registry": str(provider.registry_path),
        "witness": str(provider.witness_dir), "lock": str(provider.lock_path), "registry_id": provider.registry_id,
    })
    secure_json(root / "integration.json", {
        "label": "actual SB CLI and DB provider; simulated anchor; not TPM readiness",
        "config": str(config_path), "binding": binding_document(CONTEXT, config.handoff_policy),
        "checkpoint": model_object(local_checkpoint(provider.database, config.workspace_id, None)),
        "context": {
            "provider_instance_id": config.provider_instance_id, "workspace_id": config.workspace_id,
            "owner": config.principal_id, "agent_id": config.agent_id, "session_id": config.session_id,
            "projects": config.projects, "policy_revision": config.policy_revision,
            "deletion_sequence": config.deletion_sequence, "deletion_set_root": config.deletion_set_root,
            "processor_principal_id": config.handoff_policy.processor_principal_id,
        },
    })
    print(json.dumps({"setup": "actual SB human fixture", "root": str(root), "TPM_readiness": False}))

def setup_auto(root: Path) -> None:
    from datetime import UTC, datetime, timedelta
    import tests.company_db_auto_support as support
    from sb.effect_values import format_instant
    from tests.company_internal_auto_support import contact_body, calendar_body, progress_body, receive
    root.mkdir(mode=0o700)
    activation = format_instant(datetime.now(UTC) - timedelta(seconds=1))
    original_bootstrap = support.bootstrap_company_scope
    def bootstrap_at_activation(**kwargs):
        kwargs["now"] = activation
        return original_bootstrap(**kwargs)
    support.bootstrap_company_scope = bootstrap_at_activation
    try:
        provider, settings, context = support.real_company_runtime(root)
    finally:
        support.bootstrap_company_scope = original_bootstrap
    for name, body in (("contact", contact_body()), ("calendar", calendar_body()),
                       ("progress", progress_body()), ("money", contact_body(name="payment invoice")),
                       ("contract", contact_body(name="contract agreement"))):
        receive(provider.database, "candidate:" + name, "event:" + name, body)
    progress = Ed25519PrivateKey.generate()
    encoded = __import__("base64").urlsafe_b64encode(progress.public_key().public_bytes_raw()).rstrip(b"=").decode()
    (root / "progress.pem").write_bytes(progress.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    (root / "policy-auto.raw").write_bytes(settings.signer.private_key.private_bytes_raw())
    value = {
        "schema_version": 1, "company_database": str(provider.database),
        "personal_data_roots": [str(root / "personal")],
        "provider_instance_id": settings.provider_instance_id, "workspace_id": context.workspace_id,
        "principal_id": context.owner, "agent_id": "agent:auto-test", "session_id": "session:auto-test",
        "projects": list(context.projects), "policy_revision": context.policy_revision,
        "deletion_sequence": context.deletion_sequence, "deletion_set_root": context.deletion_set_root,
        "trusted_keys": {"progress:TEST_ONLY": encoded},
        "key_scopes": {"progress:TEST_ONLY": {"operations": ["auto_process_internal", "read_auto_report"],
                                             "source_systems": ["mail"]}},
        "internal_auto_policy": model_object(settings.policy), "policy_auto_key_id": settings.signer.key_id,
        "freshness_provider": {"schema_version": 2, "kind": "sb_company_db", "registry_id": provider.registry_id},
    }
    secure_json(root / "company-config.json", value)
    secure_json(root / "TEST_ONLY_SIMULATED_NV.json", {"name": provider.anchor.public_name().hex(),
        "value": provider.anchor.read_value().hex(), "extends": provider.anchor.extend_count})
    secure_json(root / "provider.json", {"database": str(provider.database), "registry": str(provider.registry_path),
        "witness": str(provider.witness_dir), "lock": str(provider.lock_path),
        "registry_id": provider.registry_id, "auto": True})
    secure_json(root / "integration.json", {"config": str(root / "company-config.json"),
        "installation_id": provider.installation_id, "activation_cutoff": activation,
        "context": {key: value[key] for key in ("provider_instance_id", "workspace_id", "agent_id",
            "session_id", "projects", "policy_revision", "deletion_sequence", "deletion_set_root")}})
    print(json.dumps({"setup": "actual SB internal auto fixture", "root": str(root), "TPM_readiness": False}))


if sys.argv[1] == "setup":
    setup(Path(sys.argv[2]))
elif sys.argv[1] == "setup-auto":
    setup_auto(Path(sys.argv[2]))
elif sys.argv[1] == "validate":
    validated = load_company_config(Path(sys.argv[2]))
    print(json.dumps({"scope": validated.provider_instance_id, "kind": validated.freshness_provider.kind}))
elif sys.argv[1] == "readback":
    root = Path(sys.argv[2])
    paths = json.loads((root / "provider.json").read_text())
    with closing(sqlite3.connect(paths["database"])) as db:
        operations = db.execute(
            "SELECT actor_store,operation,state,count(*) FROM company_freshness_operations GROUP BY actor_store,operation,state ORDER BY actor_store,operation"
        ).fetchall()
        receipts = db.execute(
            "SELECT operation,count(*),min(created_at),max(created_at) FROM company_memory_receipts WHERE operation IN ('accept','reject','mark_processed') GROUP BY operation ORDER BY operation"
        ).fetchall()
        internal = db.execute("SELECT record_kind,count(*) FROM company_internal_records GROUP BY record_kind ORDER BY record_kind").fetchall() if paths.get("auto") else []
    print(json.dumps({"label": "actual SB DB readback; simulated anchor; not TPM readiness",
        "operations": operations, "original_receipts": receipts, "actual_internal_records": internal}))
elif sys.argv[1] == "report-readback":
    from sb.company_auto_report import AutoReportQuery, read_auto_report
    from tests.company_internal_auto_support import report_grant
    root = Path(sys.argv[2])
    paths = json.loads((root / "provider.json").read_text())
    config = load_company_config(root / "company-config.json")
    report = read_auto_report(Path(paths["database"]), provider_instance_id=config.provider_instance_id,
        workspace_id=config.workspace_id, grant=report_grant(),
        query=AutoReportQuery(from_global_sequence=0, to_global_sequence=9007199254740991, limit=100, cursor=None))
    print(json.dumps(model_object(report)))
else:
    # The broker supplies only action --config PINNED_PATH, just as the installed CLI.
    arguments = sys.argv[1:]
    root = Path(arguments[2]).parent
    paths = json.loads((root / "provider.json").read_text())
    database = Path(paths["database"])
    provider = CompanyDbFreshnessProvider(database=database,
        actor_store="jarvis" if arguments[0] == "freshness" else "second_brain",
        registry_path=Path(paths["registry"]), witness_dir=Path(paths["witness"]),
        lock_path=Path(paths["lock"]), registry_id=paths["registry_id"],
        anchor=SimulatedPersistentNv(root, database))
    if paths.get("auto"):
        import sb.company_auto_cli
        sb.company_auto_cli.POLICY_AUTO_KEY = root / "policy-auto.raw"
    original_stderr = sys.stderr
    captured = io.BytesIO()
    class ErrorCapture:
        buffer = captured
        def __getattr__(self, name: str):
            return getattr(original_stderr, name)
    sys.stderr = ErrorCapture()
    status = main(arguments, freshness_provider=provider)
    sys.stderr = original_stderr
    if captured.getvalue():
        with (root / "cli-errors.log").open("ab") as log:
            log.write(arguments[0].encode() + b": " + captured.getvalue())
        sys.stderr.buffer.write(captured.getvalue())
    raise SystemExit(status)
