import * as dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

interface GeminiModel {
  name: string;
  displayName: string;
  description: string;
  supportedGenerationMethods: string[];
}

async function listModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Gemini API key is not configured in the .env file.');
    return;
  }

  try {
    const response = await axios.get<{ models: GeminiModel[] }>(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    const models = response.data.models;

    console.log('Available Gemini Models (for generateContent):');
    console.log('-------------------------------------------');
    models.forEach((model) => {
      if (model.supportedGenerationMethods.includes('generateContent')) {
        const modelId = model.name.replace('models/', '');
        console.log(`ID: ${modelId}`);
        console.log(`  Display Name: ${model.displayName}`);
        console.log('-------------------------------------------');
      }
    });

  } catch (error) {
    if (axios.isAxiosError(error)) {
        console.error('Error fetching models from Gemini API:', error.response?.data || error.message);
    } else {
        console.error('An unexpected error occurred:', error);
    }
  }
}

listModels();