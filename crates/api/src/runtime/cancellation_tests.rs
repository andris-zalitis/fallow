//! Cooperative cancellation of the programmatic analysis path.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::{AnalysisOptions, CombinedOptions, DeadCodeOptions, ProgrammaticError};

use super::{combined::run_combined, dead_code::run_dead_code};

fn cancellable_engine_session(
    root: &Path,
    token: Arc<AtomicBool>,
) -> fallow_engine::session::AnalysisSession {
    let options = uncached_analysis(root, Some(token));
    let context = crate::analysis_context::resolve_programmatic_analysis_context(&options)
        .expect("analysis context");
    let session =
        fallow_engine::session::AnalysisSession::load(root, None).expect("engine session");
    super::dead_code::attach_cancellation(session, &context)
}

fn uncached_analysis(root: &Path, cancellation: Option<Arc<AtomicBool>>) -> AnalysisOptions {
    AnalysisOptions {
        root: Some(root.to_path_buf()),
        no_cache: true,
        cancellation,
        ..AnalysisOptions::default()
    }
}

fn dead_code_options(root: &Path, cancellation: Option<Arc<AtomicBool>>) -> DeadCodeOptions {
    DeadCodeOptions {
        analysis: uncached_analysis(root, cancellation),
        ..DeadCodeOptions::default()
    }
}

/// What a run that never started reports. Anything else means the analysis was
/// already under way when the token flipped.
const ENTRY_GUARD_STOP: &str = "analysis was cancelled before config load and file discovery";

fn assert_cancelled(error: &ProgrammaticError) {
    assert_eq!(
        error.code.as_deref(),
        Some("FALLOW_CANCELLED"),
        "cancellation must carry its own code, got {error:?}"
    );
    assert_eq!(error.exit_code, 2);
}

/// Cancelling before the call short-circuits it. The assertion that matters is
/// the shape of the result: an empty report would read downstream as a project
/// with nothing wrong with it.
#[test]
fn a_cancelled_dead_code_run_fails_instead_of_reporting_an_empty_project() {
    let project = super::tests::dead_code_project();
    let root = project.path();

    let completed = run_dead_code(&dead_code_options(root, None)).expect("baseline analysis");
    assert!(
        !completed.results().unused_exports.is_empty(),
        "the fixture must have findings, so an empty report would be a plausible wrong answer"
    );

    let token = Arc::new(AtomicBool::new(true));
    let error = run_dead_code(&dead_code_options(root, Some(token)))
        .expect_err("a cancelled analysis must not return a report");
    assert_cancelled(&error);
    assert_eq!(
        error.message, ENTRY_GUARD_STOP,
        "a token set before the call must stop the run before it loads anything"
    );
}

#[test]
fn a_cancelled_combined_run_fails_instead_of_reporting_empty_sections() {
    let project = super::tests::dead_code_project();
    let token = Arc::new(AtomicBool::new(true));
    let error = run_combined(&CombinedOptions {
        analysis: uncached_analysis(project.path(), Some(token)),
        dead_code: true,
        duplication: true,
        health: true,
        ..CombinedOptions::default()
    })
    .expect_err("a cancelled combined analysis must not return sections");
    assert_cancelled(&error);
}

/// The API adapter must hand the live token to the engine session. Flip it
/// after construction, then exercise the engine boundary directly. The parse
/// loop's own tests cover cancellation while parsing; this test needs no timing.
#[test]
fn dead_code_engine_observes_the_api_token_after_session_creation() {
    let project = super::tests::dead_code_project();
    let token = Arc::new(AtomicBool::new(false));
    let session = cancellable_engine_session(project.path(), Arc::clone(&token));
    let completed = session
        .analyze_dead_code()
        .expect("baseline engine analysis");
    assert!(!completed.results.unused_exports.is_empty());

    token.store(true, Ordering::SeqCst);
    let error = session
        .analyze_dead_code()
        .expect_err("the engine must observe the API token after construction");
    let error = super::dead_code::map_engine_error(
        &error,
        "dead-code analysis failed",
        "FALLOW_ANALYSIS_FAILED",
        "dead-code",
    );
    assert_cancelled(&error);
    assert_ne!(error.message, ENTRY_GUARD_STOP);
}

/// Feature-flag parsing uses the same API token adapter and must observe a
/// token changed after the engine session was created, including a warm parse.
#[test]
fn feature_flag_engine_observes_the_api_token_after_session_creation() {
    let project = super::tests::dead_code_project();
    let token = Arc::new(AtomicBool::new(false));
    let session = cancellable_engine_session(project.path(), Arc::clone(&token));
    let completed = fallow_engine::flags::analyze_feature_flags_with_session(&session)
        .expect("baseline feature-flag scan");
    assert_eq!(completed.files_scanned, 3);

    token.store(true, Ordering::SeqCst);
    let error = fallow_engine::flags::analyze_feature_flags_with_session(&session)
        .expect_err("the feature-flag engine must observe the API token after construction");
    let error = super::dead_code::map_engine_error(
        &error,
        "feature-flag analysis failed",
        "FALLOW_FEATURE_FLAGS_FAILED",
        "feature-flags",
    );
    assert_cancelled(&error);
    assert_ne!(error.message, ENTRY_GUARD_STOP);
}
