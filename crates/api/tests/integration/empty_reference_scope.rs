//! A requested semantic measurement attests its graph scope even without candidates.

#![expect(clippy::expect_used, reason = "test fixture setup")]

use fallow_api::{
    DeadCodeFilters, EditorAnalysisSession, TypeAwareOptions, TypeAwareRequire, TypeAwareSession,
};
use fallow_config::DuplicatesConfig;

use crate::common::{rerun_with_type_aware_sidecar, write};

#[test]
fn empty_candidate_set_still_attests_the_requested_reference_scope() {
    if std::env::var_os("FALLOW_TYPE_AWARE_BIN").is_none() {
        rerun_with_type_aware_sidecar(
            "empty_reference_scope::empty_candidate_set_still_attests_the_requested_reference_scope",
        );
        return;
    }
    let directory = tempfile::tempdir().expect("project directory");
    let root = directory.path().canonicalize().expect("project root");
    write(
        &root,
        "package.json",
        r#"{"name":"empty-scope","private":true,"main":"index.ts"}"#,
    );
    write(
        &root,
        "tsconfig.json",
        r#"{"compilerOptions":{"strict":true},"include":["index.ts"]}"#,
    );
    write(&root, "index.ts", "console.log('active runtime source');\n");
    let session = EditorAnalysisSession::load(&root, None).expect("native session");
    let options = TypeAwareOptions {
        enabled: Some(true),
        projects: Vec::new(),
        require: TypeAwareRequire::Complete,
    };
    let filters = DeadCodeFilters {
        unused_class_members: true,
        ..DeadCodeFilters::default()
    };
    let mut persistent = TypeAwareSession::new(&root).expect("semantic session");
    let mut coverages = Vec::new();
    for use_persistent in [false, true] {
        let mut output = session
            .analyze_project_with(&DuplicatesConfig::default(), false)
            .expect("native analysis");
        let meta = if use_persistent {
            session.refine_type_aware_dead_code_in_session(
                &mut persistent,
                None,
                &options,
                &filters,
                &mut output.dead_code,
            )
        } else {
            session.refine_type_aware_dead_code(&options, &filters, &mut output.dead_code)
        }
        .expect("requested semantic analysis")
        .expect("semantic metadata");
        assert!(
            meta.executed,
            "an empty candidate set must still measure the requested graph domain"
        );
        assert_eq!(meta.candidate_count, 0);
        let coverage = meta.reference_scope.expect("attested native scope");
        assert_eq!(coverage.source_count, 1);
        assert_eq!(coverage.candidate_count, 0);
        assert!(coverage.fingerprint.is_some());
        assert!(!coverage.owning_projects.is_empty());
        coverages.push(coverage);
    }
    assert_eq!(coverages[0], coverages[1]);
}
