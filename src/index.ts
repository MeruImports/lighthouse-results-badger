import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { badgen } from 'badgen';
import AWS from 'aws-sdk';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';

async function run() {
  try {
    // Obtener inputs del action
    const reportsPath = core.getInput('reports-path') || process.cwd();
    const uploadDestination = core.getInput('upload-destination') || 's3';
    const uploadReports = core.getInput('upload-reports') || 'false';

    const s3BucketName = core.getInput('s3-bucket-name');
    const s3AccessKeyId = core.getInput('s3-access-key-id');
    const s3SecretAccessKey = core.getInput('s3-secret-access-key');
    const s3Region = core.getInput('s3-region');
    const s3Prefix = core.getInput('s3-prefix') || '';

    const azureContainerName = core.getInput('azure-container-name');
    const azureStorageAccountName = core.getInput('azure-storage-account-name');
    const azureStorageAccountKey = core.getInput('azure-storage-account-key');

    const resultCategories = core
      .getInput('result-categories')
      .split(',')
      .map(category => category.trim());

    // Leer los archivos de reportes
    const reportFiles = fs.readdirSync(reportsPath).filter(file => file.endsWith('.report.json'));

    if (!reportFiles.length) {
      core.warning('No Lighthouse reports found.');
      return;
    }

    for (const file of reportFiles) {
      const report = JSON.parse(fs.readFileSync(path.join(reportsPath, file), 'utf-8'));

      // 1. Validate the report fields
      if (!report.categories) {
        core.warning(`Invalid file ${file}`);
        continue;
      }

      // 2. Get the URL from the report
      const url = report?.finalUrl || '/main';
      let urlPath = url.replace(/(^\w+:|^)\/\/[^/]+/, '');
      urlPath = urlPath == '/' ? '/main' : urlPath;

      // 3. Create the SVGs for the specified categories as action input
      for (const label of resultCategories) {
        const score = Math.ceil((report.categories[label]?.score * 100));
        let color = 'red';
        if (score >= 90) color = 'green';
        else if (score >= 50) color = 'orange';

        const svg = badgen({ label, status: score.toString(), color });
        const svgFileName = path.join(reportsPath, file.replace('report.json', `${label}.svg`));

        fs.writeFileSync(svgFileName, svg);

        if (uploadDestination === 's3') {
          const rawName = `${s3Prefix}${urlPath}.${label}.svg`;
          await uploadToS3(svgFileName, s3BucketName, s3AccessKeyId, s3SecretAccessKey, s3Region, rawName);
        } else if (uploadDestination === 'azure') {
          await uploadToAzure(svgFileName, azureContainerName, azureStorageAccountName, azureStorageAccountKey);
        }
      }

      // 4. Upload the report to the specified if needed
      if (uploadReports === 'true') {
        const rawName = `${s3Prefix}${urlPath}.report.json`;
        if (uploadDestination === 's3') {
          await uploadToS3(path.join(reportsPath, file), s3BucketName, s3AccessKeyId, s3SecretAccessKey, s3Region, rawName, 'application/json');
        } else if (uploadDestination === 'azure') {
          await uploadToAzure(path.join(reportsPath, file), azureContainerName, azureStorageAccountName, azureStorageAccountKey);
        }
      }

    }
  } catch (error: any) {
    core.setFailed(`Action failed with error: ${error.message}`);
  }
}

/**
 * Function to upload a file to S3
 * @param filePath - Route to the file to upload
 * @param bucketName 
 * @param accessKeyId 
 * @param secretAccessKey 
 * @param region 
 */
async function uploadToS3(filePath: string, bucketName: string, accessKeyId: string, secretAccessKey: string, region: string, rawName: string, contentType = 'image/svg+xml') {
  const s3 = new AWS.S3({
    accessKeyId,
    secretAccessKey,
    region,
  });

  const fileContent = fs.readFileSync(filePath);

  const params = {
    Bucket: bucketName,
    Key: rawName,
    Body: fileContent,
    ContentType: contentType,
  };

  try {
    const data = await s3.upload(params).promise();
    core.setOutput('s3-url', data.Location);
    core.info(`Uploaded ${rawName} to S3: ${data.Location}`);
  } catch (error: any) {
    core.setFailed(`Failed to upload ${rawName} to S3: ${error.message}`);
  }
}

/**
 * Function to upload a file to Azure Blob Storage
 * @param filePath  - Route to the file to upload
 * @param containerName 
 * @param accountName 
 * @param accountKey 
 */
async function uploadToAzure(filePath: string, containerName: string, accountName: string, accountKey: string) {
  const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
  const blobServiceClient = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, sharedKeyCredential);

  const containerClient = blobServiceClient.getContainerClient(containerName);
  const fileContent = fs.readFileSync(filePath);
  const blobName = path.basename(filePath);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  try {
    await blockBlobClient.upload(fileContent, fileContent.length, {
      blobHTTPHeaders: { blobContentType: 'image/svg+xml' },
    });
    const blobUrl = blockBlobClient.url;
    core.setOutput('azure-blob-url', blobUrl);
    core.info(`Uploaded ${blobName} to Azure Blob Storage: ${blobUrl}`);
  } catch (error: any) {
    core.setFailed(`Failed to upload ${blobName} to Azure Blob Storage: ${error.message}`);
  }
}

run();
