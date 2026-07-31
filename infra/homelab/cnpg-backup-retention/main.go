package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	serviceAccountDirectory = "/var/run/secrets/kubernetes.io/serviceaccount"
	defaultAPIBaseURL       = "https://kubernetes.default.svc"
	defaultKeepCompleted    = 7
	maxResponseBytes        = 8 << 20
)

type backup struct {
	Metadata struct {
		Name              string            `json:"name"`
		CreationTimestamp string            `json:"creationTimestamp"`
		Labels            map[string]string `json:"labels"`
	} `json:"metadata"`
	Status struct {
		Phase string `json:"phase"`
	} `json:"status"`
}

type backupList struct {
	Items []backup `json:"items"`
}

type retentionConfig struct {
	APIBaseURL  string
	Namespace   string
	Schedule    string
	Keep        int
	DryRun      bool
	TokenPath   string
	CAPath      string
	HTTPTimeout time.Duration
}

type kubernetesClient struct {
	baseURL   *url.URL
	namespace string
	token     string
	client    *http.Client
}

type backupAPI interface {
	listScheduledBackups(context.Context, string) ([]backup, error)
	deleteBackup(context.Context, string) error
}

func requiredEnvironment(name string) (string, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return value, nil
}

func positiveIntegerEnvironment(name string, fallback int) (int, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return parsed, nil
}

func booleanEnvironment(name string, fallback bool) (bool, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false", name)
	}
	return parsed, nil
}

func readTrimmedFile(filePath string) (string, error) {
	value, err := os.ReadFile(filePath)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", filePath, err)
	}
	trimmed := strings.TrimSpace(string(value))
	if trimmed == "" {
		return "", fmt.Errorf("%s is empty", filePath)
	}
	return trimmed, nil
}

func loadConfig() (retentionConfig, error) {
	namespace, err := requiredEnvironment("BACKUP_NAMESPACE")
	if err != nil {
		namespace, err = readTrimmedFile(path.Join(serviceAccountDirectory, "namespace"))
		if err != nil {
			return retentionConfig{}, errors.New("BACKUP_NAMESPACE is required when the service-account namespace file is unavailable")
		}
	}
	schedule, err := requiredEnvironment("SCHEDULE_NAME")
	if err != nil {
		return retentionConfig{}, err
	}
	keep, err := positiveIntegerEnvironment("KEEP_COMPLETED", defaultKeepCompleted)
	if err != nil {
		return retentionConfig{}, err
	}
	dryRun, err := booleanEnvironment("RETENTION_DRY_RUN", true)
	if err != nil {
		return retentionConfig{}, err
	}
	return retentionConfig{
		APIBaseURL:  defaultAPIBaseURL,
		Namespace:   namespace,
		Schedule:    schedule,
		Keep:        keep,
		DryRun:      dryRun,
		TokenPath:   path.Join(serviceAccountDirectory, "token"),
		CAPath:      path.Join(serviceAccountDirectory, "ca.crt"),
		HTTPTimeout: 30 * time.Second,
	}, nil
}

func newKubernetesClient(config retentionConfig) (*kubernetesClient, error) {
	baseURL, err := url.Parse(config.APIBaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse Kubernetes API URL: %w", err)
	}
	if baseURL.Scheme != "https" || baseURL.Host == "" {
		return nil, errors.New("Kubernetes API URL must be HTTPS with a host")
	}
	token, err := readTrimmedFile(config.TokenPath)
	if err != nil {
		return nil, err
	}
	certificate, err := os.ReadFile(config.CAPath)
	if err != nil {
		return nil, fmt.Errorf("read Kubernetes CA: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(certificate) {
		return nil, errors.New("Kubernetes CA file did not contain a valid certificate")
	}
	return &kubernetesClient{
		baseURL:   baseURL,
		namespace: config.Namespace,
		token:     token,
		client: &http.Client{
			Timeout: config.HTTPTimeout,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{
					MinVersion: tls.VersionTLS12,
					RootCAs:    roots,
				},
			},
		},
	}, nil
}

func (client *kubernetesClient) request(ctx context.Context, method, requestPath string, query url.Values, body []byte) (*http.Response, error) {
	requestURL := *client.baseURL
	requestURL.Path = requestPath
	requestURL.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, method, requestURL.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+client.token)
	request.Header.Set("User-Agent", "toss-portfolio-lens-cnpg-backup-retention/1.0")
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	return client.client.Do(request)
}

func responseError(response *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
	return fmt.Errorf("Kubernetes API returned %s: %s", response.Status, strings.TrimSpace(string(body)))
}

func (client *kubernetesClient) listScheduledBackups(ctx context.Context, schedule string) ([]backup, error) {
	query := url.Values{}
	query.Set("labelSelector", "cnpg.io/scheduled-backup="+schedule)
	requestPath := fmt.Sprintf(
		"/apis/postgresql.cnpg.io/v1/namespaces/%s/backups",
		url.PathEscape(client.namespace),
	)
	response, err := client.request(ctx, http.MethodGet, requestPath, query, nil)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, responseError(response)
	}
	var result backupList
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxResponseBytes))
	if err := decoder.Decode(&result); err != nil {
		return nil, fmt.Errorf("decode Backup list: %w", err)
	}
	return result.Items, nil
}

func (client *kubernetesClient) deleteBackup(ctx context.Context, name string) error {
	deleteOptions := []byte(`{"apiVersion":"v1","kind":"DeleteOptions","propagationPolicy":"Background"}`)
	requestPath := fmt.Sprintf(
		"/apis/postgresql.cnpg.io/v1/namespaces/%s/backups/%s",
		url.PathEscape(client.namespace),
		url.PathEscape(name),
	)
	response, err := client.request(ctx, http.MethodDelete, requestPath, nil, deleteOptions)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusAccepted {
		return responseError(response)
	}
	return nil
}

func backupNamesToDelete(backups []backup, schedule string, keep int) ([]string, error) {
	type completedBackup struct {
		name      string
		createdAt time.Time
	}
	completed := make([]completedBackup, 0, len(backups))
	for _, candidate := range backups {
		if candidate.Metadata.Labels["cnpg.io/scheduled-backup"] != schedule || candidate.Status.Phase != "completed" {
			continue
		}
		if candidate.Metadata.Name == "" {
			return nil, errors.New("completed Backup is missing metadata.name")
		}
		createdAt, err := time.Parse(time.RFC3339, candidate.Metadata.CreationTimestamp)
		if err != nil {
			return nil, fmt.Errorf("Backup %s has invalid creationTimestamp: %w", candidate.Metadata.Name, err)
		}
		completed = append(completed, completedBackup{
			name:      candidate.Metadata.Name,
			createdAt: createdAt,
		})
	}
	sort.Slice(completed, func(left, right int) bool {
		if completed[left].createdAt.Equal(completed[right].createdAt) {
			return completed[left].name < completed[right].name
		}
		return completed[left].createdAt.Before(completed[right].createdAt)
	})
	deleteCount := len(completed) - keep
	if deleteCount <= 0 {
		return nil, nil
	}
	names := make([]string, deleteCount)
	for index := range deleteCount {
		names[index] = completed[index].name
	}
	return names, nil
}

func applyRetention(ctx context.Context, client backupAPI, config retentionConfig) error {
	backups, err := client.listScheduledBackups(ctx, config.Schedule)
	if err != nil {
		return fmt.Errorf("list scheduled Backups: %w", err)
	}
	names, err := backupNamesToDelete(backups, config.Schedule, config.Keep)
	if err != nil {
		return err
	}
	log.Printf(
		"namespace=%q schedule=%q matched=%d keep_completed=%d delete=%d dry_run=%t",
		config.Namespace,
		config.Schedule,
		len(backups),
		config.Keep,
		len(names),
		config.DryRun,
	)
	for _, name := range names {
		if config.DryRun {
			log.Printf("dry-run delete Backup %q", name)
			continue
		}
		if err := client.deleteBackup(ctx, name); err != nil {
			return fmt.Errorf("delete Backup %s: %w", name, err)
		}
		log.Printf("deleted Backup %q", name)
	}
	return nil
}

func run(ctx context.Context, config retentionConfig) error {
	client, err := newKubernetesClient(config)
	if err != nil {
		return err
	}
	return applyRetention(ctx, client, config)
}

func main() {
	config, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	if err := run(context.Background(), config); err != nil {
		log.Fatal(err)
	}
}
