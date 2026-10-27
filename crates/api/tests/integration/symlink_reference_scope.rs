//! Native canonical graph identities cross both semantic transports unchanged.

#![cfg(unix)]
#![expect(clippy::expect_used, reason = "test fixture setup")]

use fallow_api::{
    DeadCodeFilters, EditorAnalysisSession, TypeAwareOptions, TypeAwareRequire, TypeAwareSession,
};
use fallow_config::DuplicatesConfig;
use fallow_types::output_dead_code::UnusedClassMemberFinding;
use fallow_types::results::{AnalysisResults, MemberKind, UnusedMember};
use fallow_types::semantic::{ReferenceScope, SemanticCandidateDecisionKind};

use crate::common::{rerun_with_type_aware_sidecar, write};

#[test]
fn contained_source_link_credits_one_canonical_caller_in_both_transports() {
    if std::env::var_os("FALLOW_TYPE_AWARE_BIN").is_none() {
        rerun_with_type_aware_sidecar(
            "symlink_reference_scope::contained_source_link_credits_one_canonical_caller_in_both_transports",
        );
        return;
    }
    let directory = tempfile::tempdir().expect("project directory");
    let root = directory.path().canonicalize().expect("canonical root");
    write(
        &root,
        "package.json",
        r#"{"name":"canonical-scope","private":true,"main":"src/caller-link.ts"}"#,
    );
    write(
        &root,
        "tsconfig.json",
        r#"{"compilerOptions":{"strict":true},"include":["src"]}"#,
    );
    write(
        &root,
        "src/worker.ts",
        "export class Worker {\n  execute(): void {}\n}\nexport const worker = new Worker();\n",
    );
    write(
        &root,
        "src/caller.ts",
        "import { worker } from './worker';\nworker.execute();\n",
    );
    std::os::unix::fs::symlink("caller.ts", root.join("src/caller-link.ts"))
        .expect("contained source link");
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
    let mut decisions = Vec::new();
    let mut coverages = Vec::new();
    for use_persistent in [false, true] {
        let mut output = session
            .analyze_project_with(&DuplicatesConfig::default(), false)
            .expect("native analysis");
        let Some(ReferenceScope::Graph { sources, roots, .. }) = &output.dead_code.reference_scope
        else {
            panic!("native graph projection")
        };
        assert_eq!(sources, &["src/caller.ts", "src/worker.ts"]);
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].path, "src/caller.ts");
        // Supply one exact candidate at the client seam. Discovery and the
        // graph produce the reference domain; member selection is independent.
        output.dead_code.results = AnalysisResults::default();
        output
            .dead_code
            .results
            .unused_class_members
            .push(UnusedClassMemberFinding::with_actions(UnusedMember {
                path: root.join("src/worker.ts"),
                parent_name: "Worker".into(),
                member_name: "execute".into(),
                kind: MemberKind::ClassMethod,
                line: 2,
                col: 2,
            }));
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
        assert_eq!(meta.candidate_count, 1);
        assert_eq!(meta.candidate_decisions.len(), 1);
        let decision = &meta.candidate_decisions[0];
        assert_eq!(
            decision.decision,
            SemanticCandidateDecisionKind::ConfirmedUsed
        );
        assert_eq!(decision.total_evidence_count, 1);
        assert_eq!(decision.evidence.len(), 1);
        assert_eq!(decision.evidence[0].path, "src/caller.ts");
        assert!(output.dead_code.results.unused_class_members.is_empty());
        decisions.push(decision.clone());
        coverages.push(meta.reference_scope.expect("attested scope"));
    }
    assert_eq!(decisions[0], decisions[1]);
    assert_eq!(coverages[0], coverages[1]);
}
