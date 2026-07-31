package main

import (
	"context"
	"reflect"
	"testing"
)

func testBackup(name, timestamp, schedule, phase string) backup {
	var result backup
	result.Metadata.Name = name
	result.Metadata.CreationTimestamp = timestamp
	result.Metadata.Labels = map[string]string{"cnpg.io/scheduled-backup": schedule}
	result.Status.Phase = phase
	return result
}

func TestBackupNamesToDeleteKeepsNewestCompletedForExactSchedule(t *testing.T) {
	backups := []backup{
		testBackup("newest", "2026-07-31T03:00:00Z", "daily", "completed"),
		testBackup("running", "2026-07-31T04:00:00Z", "daily", "running"),
		testBackup("oldest", "2026-07-29T03:00:00Z", "daily", "completed"),
		testBackup("middle", "2026-07-30T03:00:00Z", "daily", "completed"),
		testBackup("other-schedule", "2026-07-28T03:00:00Z", "weekly", "completed"),
	}
	names, err := backupNamesToDelete(backups, "daily", 2)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(names, []string{"oldest"}) {
		t.Fatalf("unexpected deletion plan: %#v", names)
	}
}

func TestBackupNamesToDeleteFailsClosedOnInvalidCompletedTimestamp(t *testing.T) {
	backups := []backup{
		testBackup("invalid", "not-a-time", "daily", "completed"),
		testBackup("valid", "2026-07-31T03:00:00Z", "daily", "completed"),
	}
	if _, err := backupNamesToDelete(backups, "daily", 1); err == nil {
		t.Fatal("expected invalid timestamp error")
	}
}

func TestBackupNamesToDeleteUsesNameAsStableTieBreaker(t *testing.T) {
	backups := []backup{
		testBackup("backup-b", "2026-07-31T03:00:00Z", "daily", "completed"),
		testBackup("backup-a", "2026-07-31T03:00:00Z", "daily", "completed"),
	}
	names, err := backupNamesToDelete(backups, "daily", 1)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(names, []string{"backup-a"}) {
		t.Fatalf("unexpected deletion plan: %#v", names)
	}
}

type fakeBackupAPI struct {
	backups []backup
	deleted []string
}

func (fake *fakeBackupAPI) listScheduledBackups(_ context.Context, _ string) ([]backup, error) {
	return fake.backups, nil
}

func (fake *fakeBackupAPI) deleteBackup(_ context.Context, name string) error {
	fake.deleted = append(fake.deleted, name)
	return nil
}

func TestApplyRetentionDeletesOnlyOldestCompletedBackup(t *testing.T) {
	client := &fakeBackupAPI{backups: []backup{
		testBackup("oldest", "2026-07-29T03:00:00Z", "daily", "completed"),
		testBackup("middle", "2026-07-30T03:00:00Z", "daily", "completed"),
		testBackup("newest", "2026-07-31T03:00:00Z", "daily", "completed"),
		testBackup("running", "2026-07-31T04:00:00Z", "daily", "running"),
	}}
	err := applyRetention(context.Background(), client, retentionConfig{
		Namespace: "pg",
		Schedule:  "daily",
		Keep:      2,
		DryRun:    false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(client.deleted, []string{"oldest"}) {
		t.Fatalf("unexpected API deletions: %#v", client.deleted)
	}
}
