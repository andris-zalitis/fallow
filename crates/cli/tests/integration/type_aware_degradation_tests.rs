#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "tests and benches use unwrap and expect to keep fixture setup concise"
)]

//! Requested semantic dead-code analysis fails when the companion cannot run.
//! Best-effort still permits successful partial evidence; health coupling has
//! its own degradation contract.

use crate::common::{CommandOutput, fixture_path, parse_json, run_fallow_raw_with_env};

const FIXTURE: &str = "type-aware-unused-export-refinement";
const DEGRADED_NOTICE: &str = "showing conservative syntactic findings";

/// Point the sidecar resolution at a path that does not exist, which is the
/// same failure class the transport reports for a timeout or a crash.
fn run_with_missing_companion(args: &[&str]) -> CommandOutput {
    let root = fixture_path(FIXTURE);
    let missing = root.join("missing-type-aware-companion");
    let missing_arg = missing.to_string_lossy().to_string();
    let root_arg = root.to_string_lossy().to_string();
    let mut full = vec![args[0], "--root", root_arg.as_str()];
    full.extend_from_slice(&args[1..]);
    run_fallow_raw_with_env(&full, &[("FALLOW_TYPE_AWARE_BIN", &missing_arg)])
}

#[test]
fn check_fails_requested_semantic_analysis_under_best_effort() {
    let output = run_with_missing_companion(&[
        "dead-code",
        "--type-aware",
        "--unused-exports",
        "--format",
        "json",
        "--quiet",
    ]);

    assert_eq!(output.code, 2, "stderr: {}", output.stderr);
    let json = parse_json(&output);
    assert_eq!(json["error"], true);
    assert_eq!(json["exit_code"], 2);
    assert!(
        json["message"]
            .as_str()
            .unwrap()
            .contains("Type-aware analysis failed")
    );
    assert!(json.get("unused_exports").is_none());
    assert!(json.get("_meta").is_none());
}

#[test]
fn check_still_fails_closed_under_require_complete() {
    let output = run_with_missing_companion(&[
        "dead-code",
        "--type-aware",
        "--type-aware-require",
        "complete",
        "--unused-exports",
        "--format",
        "json",
        "--quiet",
    ]);

    assert_eq!(output.code, 2, "stdout: {}", output.stdout);
    assert!(
        output.stdout.contains("Type-aware analysis failed"),
        "stdout: {}",
        output.stdout
    );
}

/// A failed requested pass emits one error and no successful refinement report.
#[test]
fn human_check_states_the_semantic_failure_once_and_claims_no_success() {
    let output = run_with_missing_companion(&["dead-code", "--type-aware", "--unused-exports"]);
    let emitted = format!("{}{}", output.stdout, output.stderr);

    assert_eq!(
        emitted.matches("Type-aware analysis failed").count(),
        1,
        "stdout: {}\nstderr: {}",
        output.stdout,
        output.stderr
    );
    assert_eq!(output.code, 2);
    assert!(!emitted.contains(DEGRADED_NOTICE));
    assert!(
        !emitted.contains("Type-aware refinement:"),
        "a pass that never ran must not report counts: {emitted}"
    );
}

#[test]
fn human_health_coupling_states_the_degradation_once() {
    let output = run_with_missing_companion(&["health", "--type-aware", "--type-coupling"]);
    let emitted = format!("{}{}", output.stdout, output.stderr);

    assert_eq!(
        emitted.matches(DEGRADED_NOTICE).count(),
        1,
        "stdout: {}\nstderr: {}",
        output.stdout,
        output.stderr
    );
}

/// Quiet JSON keeps the structured failure on stdout and stderr empty.
#[test]
fn quiet_json_keeps_the_semantic_failure_structured_on_stdout() {
    let output = run_with_missing_companion(&[
        "dead-code",
        "--type-aware",
        "--unused-exports",
        "--format",
        "json",
        "--quiet",
    ]);

    assert_eq!(output.code, 2);
    assert!(output.stderr.is_empty(), "stderr: {}", output.stderr);
    let json = parse_json(&output);
    assert_eq!(json["error"], true);
    assert_eq!(json["exit_code"], 2);
    assert!(
        json["message"]
            .as_str()
            .unwrap()
            .contains("Type-aware analysis failed")
    );
    assert!(json.get("_meta").is_none());
}

/// Fix also requires the requested semantic evidence before proposing deletions.
#[test]
fn fix_dry_run_fails_closed_even_under_best_effort() {
    let output = run_with_missing_companion(&[
        "fix",
        "--type-aware",
        "--dry-run",
        "--format",
        "json",
        "--quiet",
    ]);

    assert_eq!(output.code, 2, "stdout: {}", output.stdout);
    assert!(
        output.stdout.contains("Type-aware analysis failed"),
        "stdout: {}",
        output.stdout
    );
    // The failure explains the timeout setting and the explicit opt-out.
    assert!(
        output.stdout.contains("FALLOW_TYPE_AWARE_TIMEOUT_SECS"),
        "stdout: {}",
        output.stdout
    );
    assert!(
        output.stdout.contains("--no-type-aware"),
        "stdout: {}",
        output.stdout
    );
}

#[test]
fn fix_dry_run_still_fails_closed_under_require_complete() {
    let output = run_with_missing_companion(&[
        "fix",
        "--type-aware",
        "--type-aware-require",
        "complete",
        "--dry-run",
        "--format",
        "json",
        "--quiet",
    ]);

    assert_eq!(output.code, 2, "stdout: {}", output.stdout);
    assert!(
        output.stdout.contains("Type-aware analysis failed"),
        "stdout: {}",
        output.stdout
    );
}

#[test]
fn health_type_coupling_degrades_under_best_effort() {
    let output = run_with_missing_companion(&[
        "health",
        "--type-aware",
        "--type-coupling",
        "--format",
        "json",
        "--quiet",
    ]);

    assert_ne!(output.code, 2, "stderr: {}", output.stderr);
    let json = parse_json(&output);
    let warnings = json["_meta"]["type_aware"]["warnings"]
        .as_array()
        .expect("degraded coupling records the reason in _meta.type_aware.warnings");
    assert!(
        warnings[0].as_str().unwrap().contains(DEGRADED_NOTICE),
        "warnings: {warnings:?}"
    );
}

#[test]
fn health_type_coupling_still_fails_closed_under_require_complete() {
    let output = run_with_missing_companion(&[
        "health",
        "--type-aware",
        "--type-coupling",
        "--type-aware-require",
        "complete",
        "--format",
        "json",
        "--quiet",
    ]);

    assert_eq!(output.code, 2, "stdout: {}", output.stdout);
    assert!(
        output.stdout.contains("Type-aware coupling failed"),
        "stdout: {}",
        output.stdout
    );
}

#[test]
fn combined_run_degrades_under_best_effort() {
    let output = run_with_missing_companion(&[
        "--type-aware",
        "--only",
        "health",
        "--format",
        "json",
        "--quiet",
    ]);

    assert_ne!(output.code, 2, "stderr: {}", output.stderr);
    assert!(
        !output.stdout.contains("Type-aware coupling failed"),
        "stdout: {}",
        output.stdout
    );
}

#[test]
fn combined_run_still_fails_closed_under_require_complete() {
    let output = run_with_missing_companion(&[
        "--type-aware",
        "--type-aware-require",
        "complete",
        "--only",
        "health",
        "--format",
        "json",
        "--quiet",
    ]);

    assert_eq!(output.code, 2, "stdout: {}", output.stdout);
    assert!(
        output.stdout.contains("Type-aware coupling failed"),
        "stdout: {}",
        output.stdout
    );
}
